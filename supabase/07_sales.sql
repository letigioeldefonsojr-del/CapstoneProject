-- Almares 328 - Supabase step 7: sales records (POS sales, refunds, stock log, daily tally).
-- Paste into SQL Editor > Run (once). Safe to run again.

create table if not exists public.pos_sales (
  id             text primary key,
  created_at     timestamptz not null default now(),
  receipt_no     text,
  total          numeric(12,2) not null default 0,
  refunded_total numeric(12,2) not null default 0,
  refund_status  text,
  customer_id    text,
  customer_name  text,
  payment_method text,
  cashier_email  text,
  data           jsonb not null            -- the whole sale as the app uses it
);
create index if not exists pos_sales_created_idx  on public.pos_sales (created_at desc);
create index if not exists pos_sales_receipt_idx  on public.pos_sales (receipt_no);

create table if not exists public.pos_refunds (
  id         text primary key,
  sale_id    text not null,
  created_at timestamptz not null default now(),
  data       jsonb not null
);
create index if not exists pos_refunds_sale_idx on public.pos_refunds (sale_id);

create table if not exists public.stock_movements (
  id                 text primary key,
  created_at         timestamptz not null default now(),
  product_id         text,
  product_name       text,
  variant_name       text,
  type               text not null,         -- sale | return | count | manual_edit
  previous_stock     integer,
  new_stock          integer,
  unit_price         numeric(12,2),
  pos_sale_id        text,
  pos_refund_id      text,
  performed_by_email text,
  performed_by_role  text
);
create index if not exists stock_mov_type_created_idx on public.stock_movements (type, created_at desc);
create index if not exists stock_mov_created_idx      on public.stock_movements (created_at desc);

-- One row per day: units sold per product that day.
create table if not exists public.sales_daily (
  day   text primary key,                   -- "2026-10-29" (store's local day)
  units jsonb not null default '{}'::jsonb
);

-- Locked: only the store-api function (service role) can touch these.
alter table public.pos_sales        enable row level security;
alter table public.pos_refunds      enable row level security;
alter table public.stock_movements  enable row level security;
alter table public.sales_daily      enable row level security;
revoke all on public.pos_sales, public.pos_refunds, public.stock_movements, public.sales_daily from anon, authenticated;

-- Adds units to a day's tally.
create or replace function public.bump_daily(d text, u jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare k text; v numeric; cur jsonb;
begin
  if d is null or u is null or u = '{}'::jsonb then return; end if;
  insert into public.sales_daily (day, units) values (d, '{}'::jsonb) on conflict (day) do nothing;
  select units into cur from public.sales_daily where day = d for update;
  for k, v in select key, value::numeric from jsonb_each_text(u) loop
    cur := jsonb_set(cur, array[k], to_jsonb(coalesce((cur->>k)::numeric, 0) + v));
  end loop;
  update public.sales_daily set units = cur where day = d;
end $$;

-- Saves a sale, its stock log lines and the daily tally together. A repeat of
-- the same sale id changes nothing (safe to retry after a dropped connection).
create or replace function public.record_sale(sale_id text, sale jsonb, movements jsonb, d text, u jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare inserted int;
begin
  perform pg_advisory_xact_lock(hashtext('sale:' || sale_id));
  insert into public.pos_sales (id, receipt_no, total, customer_id, customer_name, payment_method, cashier_email, data)
  values (
    sale_id, sale->>'receiptNo', coalesce((sale->>'total')::numeric, 0),
    nullif(sale->>'customerId',''), nullif(sale->>'customerName',''),
    sale->>'paymentMethod', sale->>'cashierEmail', sale
  )
  on conflict (id) do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then return jsonb_build_object('duplicate', true); end if;

  insert into public.stock_movements
    (id, product_id, product_name, variant_name, type, previous_stock, new_stock, unit_price,
     pos_sale_id, performed_by_email, performed_by_role)
  select gen_random_uuid()::text, m->>'productId', m->>'productName', nullif(m->>'variantName',''), 'sale',
         nullif(m->>'previousStock','')::int, nullif(m->>'newStock','')::int, nullif(m->>'unitPrice','')::numeric,
         sale_id, sale->>'cashierEmail', sale->>'cashierRole'
  from jsonb_array_elements(coalesce(movements, '[]'::jsonb)) m;

  perform public.bump_daily(d, u);
  return jsonb_build_object('duplicate', false);
end $$;

-- Saves a refund: updates the sale, writes the refund and any "return" stock log lines.
-- `expected` is the refund state the screen saw; if someone else refunded in the
-- meantime, nothing is changed ("sale_changed").
create or replace function public.record_refund(sale_id text, expected jsonb, upd jsonb, refund jsonb, refund_id text, movements jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare s public.pos_sales%rowtype; newtotal numeric;
begin
  select * into s from public.pos_sales where id = sale_id for update;
  if not found then raise exception 'sale_missing'; end if;
  if coalesce(s.data->'refundedQtys', 'null'::jsonb) is distinct from coalesce(expected, 'null'::jsonb) then
    raise exception 'sale_changed';
  end if;
  newtotal := (upd->>'refundedTotal')::numeric;
  if newtotal is null or newtotal > s.total + 0.001 or newtotal < s.refunded_total then
    raise exception 'bad_refund';
  end if;

  update public.pos_sales
     set data = data || jsonb_build_object(
           'refundedQtys', upd->'refundedQtys',
           'refundedTotal', upd->'refundedTotal',
           'refundStatus', upd->'refundStatus'),
         refunded_total = newtotal,
         refund_status = upd->>'refundStatus'
   where id = sale_id;

  insert into public.pos_refunds (id, sale_id, data) values (refund_id, sale_id, refund)
  on conflict (id) do nothing;

  insert into public.stock_movements
    (id, product_id, product_name, variant_name, type, previous_stock, new_stock, unit_price,
     pos_sale_id, pos_refund_id, performed_by_email, performed_by_role)
  select gen_random_uuid()::text, m->>'productId', m->>'productName', nullif(m->>'variantName',''), 'return',
         nullif(m->>'previousStock','')::int, nullif(m->>'newStock','')::int, nullif(m->>'unitPrice','')::numeric,
         sale_id, refund_id, refund->>'cashierEmail', refund->>'cashierRole'
  from jsonb_array_elements(coalesce(movements, '[]'::jsonb)) m;

  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.bump_daily(text, jsonb) from public, anon, authenticated;
revoke all on function public.record_sale(text, jsonb, jsonb, text, jsonb) from public, anon, authenticated;
revoke all on function public.record_refund(text, jsonb, jsonb, jsonb, text, jsonb) from public, anon, authenticated;
grant execute on function public.bump_daily(text, jsonb) to service_role;
grant execute on function public.record_sale(text, jsonb, jsonb, text, jsonb) to service_role;
grant execute on function public.record_refund(text, jsonb, jsonb, jsonb, text, jsonb) to service_role;
