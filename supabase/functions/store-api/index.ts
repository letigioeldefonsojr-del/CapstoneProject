// Almares 328 - Supabase Edge Function "store-api"
// The gatekeeper for every change to products and stock.
//
// 1. Verifies the caller's Firebase login token (signature, issuer, audience, expiry).
// 2. Confirms the person is approved staff (checked once against Firestore, then
//    remembered in the public.staff table).
// 3. Runs the requested action with the service role.
//
// Request:  POST  { "action": "...", ...payload }   Header: Authorization: Bearer <Firebase ID token>
import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";

const PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID") ?? "almares-328-database";
const jwks = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
);
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-firebase-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function verify(idToken: string): Promise<string> {
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: `https://securetoken.google.com/${PROJECT_ID}`,
    audience: PROJECT_ID,
  });
  if (!payload.sub) throw new Error("no subject");
  return payload.sub;
}

// Looks up a Firestore document with the user's OWN token (so Firestore's rules decide).
async function firestoreDoc(path: string, idToken: string) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (res.status === 200) return await res.json();
  return null;
}

async function staffRole(uid: string, idToken: string): Promise<"admin" | "employee" | null> {
  const { data } = await admin.from("staff").select("role").eq("firebase_uid", uid).maybeSingle();
  if (data?.role) return data.role;
  // First time we see this person: ask Firestore, then remember the answer.
  if (await firestoreDoc(`admins/${uid}`, idToken)) {
    await admin.from("staff").upsert({ firebase_uid: uid, role: "admin" });
    return "admin";
  }
  const emp = await firestoreDoc(`employees/${uid}`, idToken);
  if (emp) {
    const f = emp.fields ?? {};
    const approved = f.approved?.booleanValue !== false;
    const driver = f.isDriver?.booleanValue === true;
    if (approved && !driver) {
      await admin.from("staff").upsert({ firebase_uid: uid, role: "employee" });
      return "employee";
    }
  }
  return null;
}



// ---- BEGIN PURE HELPERS (no network; tested on their own) ----
const DEL = "__delete__";
const NOW = "__now__";
const money = (v: any): number | null => {
  if (v === null || v === undefined || v === "" || v === DEL) return null;
  if (typeof v === "number") return Number.isNaN(v) ? null : v;
  const n = parseFloat(String(v).replace(/[^\d.]/g, ""));
  return Number.isNaN(n) ? null : n;
};
const STAFF_FIELDS = ["stockCount", "available", "flavors", "barcode", "barcodes", "searchTokens"];

// Applies an edit written in the app's own field names ({ price: "₱45.00", stockCount: 3, ... })
// to a products row, returning the new row and the new wholesale prices.
function applyFields(row: any, ws: any, fields: Record<string, any>) {
  const out: any = { ...row, flavors: Array.isArray(row.flavors) ? row.flavors : [], extra: { ...(row.extra ?? {}) } };
  const w: any = { wholesale_price: ws?.wholesale_price ?? null, variant_prices: { ...(ws?.variant_prices ?? {}) } };
  const nowSeconds = Math.floor(Date.now() / 1000);
  for (const [k, raw] of Object.entries(fields)) {
    const v = raw === NOW ? { seconds: nowSeconds, nanoseconds: 0 } : raw;
    switch (k) {
      case "id": case "createdAt": case "searchTokens": break;
      case "name": out.name = v === DEL || v == null ? "" : String(v); break;
      case "category": out.category = v === DEL || v == null ? "" : String(v); break;
      case "price": out.price = money(v) ?? 0; break;
      case "wholesalePrice": w.wholesale_price = money(v); break;
      case "stockCount": out.stock_count = v === DEL || v === null || v === undefined ? null : Number(v); break;
      case "available": out.available = v !== false; break;
      case "barcode": out.barcode = v === DEL || v === null || v === "" ? null : String(v); break;
      case "sku": out.sku = v === DEL || v === null || v === "" ? null : String(v); break;
      case "barcodes": out.barcodes = Array.isArray(v) ? v.map(String) : []; break;
      case "flavors": {
        const list = Array.isArray(v) ? v : [];
        const vp: Record<string, number> = {};
        out.flavors = list.map((f: any) => {
          if (!f || typeof f !== "object") return f;
          const { wholesalePrice, ...rest } = f;
          const name = rest.name ?? rest.flavor ?? rest.label;
          const wp = money(wholesalePrice);
          if (name != null && wp !== null) vp[name] = wp;
          return { ...rest, price: money(rest.price) };
        });
        w.variant_prices = vp;
        break;
      }
      default:
        if (v === DEL) delete out.extra[k]; else out.extra[k] = v;
    }
  }
  if (("barcode" in fields || "flavors" in fields) && !("barcodes" in fields)) {
    const codes = new Set<string>((out.barcodes ?? []).map(String));
    if (out.barcode) codes.add(out.barcode);
    out.flavors.forEach((f: any) => { if (f && f.barcode) codes.add(String(f.barcode)); });
    out.barcodes = [...codes];
  }
  if (out.flavors.length > 0) out.price = out.price ?? 0;
  return { row: out, wholesale: w };
}
// ---- END PURE HELPERS ----

// Attach wholesale prices (kept in a locked table) to product rows.
async function withWholesale(rows: any[]) {
  if (rows.length === 0) return rows;
  const { data } = await admin.from("product_wholesale").select("*").in("product_id", rows.map((r) => r.id));
  const byId = new Map<string, any>((data ?? []).map((w: any) => [w.product_id, w] as [string, any]));
  return rows.map((r) => ({
    ...r,
    wholesale_price: byId.get(r.id)?.wholesale_price ?? null,
    variant_prices: byId.get(r.id)?.variant_prices ?? {},
  }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const token = (req.headers.get("x-firebase-token") ?? req.headers.get("authorization") ?? "")
    .replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "not_signed_in" }, 401);

  let uid: string;
  try { uid = await verify(token); } catch { return json({ error: "bad_token" }, 401); }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  // ---- Customer app actions: any signed-in user, limited to what a shopper needs ----
  if (typeof body.action === "string" && body.action.startsWith("app_")) {
    try {
      const pub = (r: any) => { const { search_text: _s, ...rest } = r; return rest; };
      switch (body.action) {
        // The whole catalog in pages. body: { offset, limit }
        case "app_list_products": {
          const offset = Math.max(0, Number(body.offset) || 0);
          const lim = Math.min(Math.max(Number(body.limit) || 1000, 1), 1000);
          const { data, error } = await admin.from("products").select("*").order("id").range(offset, offset + lim - 1);
          if (error) return json({ error: error.message }, 400);
          const rows = (await withWholesale(data ?? [])).map(pub);
          return json({ ok: true, products: rows, done: (data ?? []).length < lim });
        }
        // Fresh copies of specific products. body.ids (max 200)
        case "app_get_products": {
          const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200).map(String) : [];
          if (ids.length === 0) return json({ ok: true, products: [] });
          const { data, error } = await admin.from("products").select("*").in("id", ids);
          if (error) return json({ error: error.message }, 400);
          return json({ ok: true, products: (await withWholesale(data ?? [])).map(pub) });
        }
        // Take stock for an order. body: { items:[{id,variant,qty}], ref }. Safe to repeat for the same ref.
        case "app_apply_sale": {
          const ref = String(body.ref ?? "").trim();
          const items: any[] = Array.isArray(body.items) ? body.items : [];
          if (!ref || ref.length > 100 || items.length === 0 || items.length > 60) return json({ error: "bad_request" }, 400);
          for (const it of items) {
            const q = Number(it?.qty);
            if (!it?.id || !Number.isInteger(q) || q < 1 || q > 500) return json({ error: "bad_quantity" }, 400);
          }
          const clean = items.map((it) => ({ id: String(it.id), variant: it.variant ?? null, qty: Number(it.qty) }));
          const key = `app:${uid}:${ref}`;
          const { data, error } = await admin.rpc("apply_sale", { items: clean, sale_ref: key });
          if (error) return json({ error: error.message }, 409);
          // remember what was taken, so only that exact amount can be given back
          await admin.from("applied_sales").upsert({ ref: `items:${key}`, r: clean });
          return json({ ok: true, updated: data });
        }
        // Give back what app_apply_sale took for this ref (once). body: { ref }
        case "app_restock": {
          const ref = String(body.ref ?? "").trim();
          const key = `app:${uid}:${ref}`;
          const { data: rec } = await admin.from("applied_sales").select("r").eq("ref", `items:${key}`).maybeSingle();
          if (!rec) return json({ error: "nothing_to_restock" }, 404);
          const mark = await admin.from("applied_sales").insert({ ref: `restocked:${key}`, r: [] });
          if (mark.error) return json({ ok: true, already: true }); // already given back
          const { data, error } = await admin.rpc("restock", { items: rec.r });
          if (error) {
            await admin.from("applied_sales").delete().eq("ref", `restocked:${key}`);
            return json({ error: error.message }, 409);
          }
          return json({ ok: true, updated: data });
        }
        // Tell the staff something happened (a customer placed or cancelled an order).
        // body: { message, orderId? , data? }
        case "app_notify_staff": {
          const message = String(body.message ?? "").trim();
          if (message.length < 1 || message.length >= 500) return json({ error: "bad_message" }, 400);
          const extra = body.data && typeof body.data === "object" ? body.data : {};
          if (body.orderId) (extra as any).orderId = String(body.orderId).slice(0, 100);
          if (JSON.stringify(extra).length > 2000) return json({ error: "too_big" }, 400);
          // at most 40 per person per hour
          const since = new Date(Date.now() - 3600_000).toISOString();
          const { count } = await admin.from("staff_notifications").select("id", { count: "exact", head: true })
            .eq("sender", uid).gte("created_at", since);
          if ((count ?? 0) >= 40) return json({ error: "too_many" }, 429);
          const { error } = await admin.from("staff_notifications").insert({ sender: uid, message, data: extra });
          if (error) return json({ error: error.message }, 400);
          return json({ ok: true });
        }
        default:
          return json({ error: "unknown_action" }, 400);
      }
    } catch (e) {
      return json({ error: String((e as Error)?.message ?? e) }, 500);
    }
  }

  const role = await staffRole(uid, token);
  if (!role) return json({ error: "not_staff" }, 403);

  try {
    switch (body.action) {
      // Sale: deduct stock safely. body.items = [{id, variant, qty}]
      case "apply_sale": {
        const { data, error } = await admin.rpc("apply_sale", { items: body.items, sale_ref: body.ref ?? null });
        if (error) return json({ error: error.message }, 409);
        return json({ ok: true, updated: data });
      }
      // Refund or undo a failed sale. body.items = [{id, variant, qty}]
      case "restock": {
        const { data, error } = await admin.rpc("restock", { items: body.items });
        if (error) return json({ error: error.message }, 409);
        return json({ ok: true, updated: data });
      }
      // Admin rejects a customer's online order: give back exactly what the app took for it (once).
      // body: { userId, ref }  - the same ref the customer app used when it took the stock.
      case "restock_order": {
        if (role !== "admin") return json({ error: "admin_only" }, 403);
        const userId = String(body.userId ?? "").trim();
        const ref = String(body.ref ?? "").trim();
        if (!userId || !ref || userId.length > 128 || ref.length > 100) return json({ error: "bad_request" }, 400);
        const key = `app:${userId}:${ref}`;
        const { data: rec } = await admin.from("applied_sales").select("r").eq("ref", `items:${key}`).maybeSingle();
        if (!rec) return json({ error: "nothing_to_restock" }, 404);
        const mark = await admin.from("applied_sales").insert({ ref: `restocked:${key}`, r: [] });
        if (mark.error) return json({ ok: true, already: true }); // already given back (e.g. the customer cancelled first)
        const { data, error } = await admin.rpc("restock", { items: rec.r });
        if (error) {
          await admin.from("applied_sales").delete().eq("ref", `restocked:${key}`);
          return json({ error: error.message }, 409);
        }
        return json({ ok: true, updated: data });
      }
      // Save a real barcode on a product (scan-and-link). body: {id, barcode, variant?}
      case "link_barcode": {
        const { data: p, error: e1 } = await admin.from("products").select("*").eq("id", body.id).single();
        if (e1 || !p) return json({ error: "product_missing" }, 404);
        const barcodes = Array.from(new Set([...(p.barcodes ?? []), body.barcode]));
        const patch: Record<string, unknown> = { barcodes, updated_at: new Date().toISOString() };
        if (body.variant) {
          patch.flavors = (p.flavors ?? []).map((v: any) =>
            (v?.name ?? v?.flavor ?? v?.label) === body.variant ? { ...v, barcode: body.barcode } : v);
        } else {
          patch.barcode = body.barcode;
        }
        const { error } = await admin.from("products").update(patch).eq("id", body.id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
      // Admin only: create or edit a product. body.product = row, body.wholesale = {wholesale_price, variant_prices}
      case "upsert_product": {
        if (role !== "admin") return json({ error: "admin_only" }, 403);
        const { error } = await admin.from("products")
          .upsert({ ...body.product, updated_at: new Date().toISOString() });
        if (error) return json({ error: error.message }, 400);
        if (body.wholesale) {
          await admin.from("product_wholesale").upsert({ product_id: body.product.id, ...body.wholesale });
        }
        return json({ ok: true });
      }
      // Admin only: delete products. body.ids = [...]
      case "delete_products": {
        if (role !== "admin") return json({ error: "admin_only" }, 403);
        const { error } = await admin.from("products").delete().in("id", body.ids);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }
      // ---- Inventory ----
      // The whole product list (staff), in pages. body: { offset, limit }
      case "list_products": {
        const offset = Math.max(0, Number(body.offset) || 0);
        const lim = Math.min(Math.max(Number(body.limit) || 1000, 1), 1000);
        const { data, error } = await admin.from("products").select("*").order("id").range(offset, offset + lim - 1);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, products: await withWholesale(data ?? []), done: (data ?? []).length < lim });
      }
      // Sidebar badge + Dashboard numbers: total product count and the products
      // that might need an alert (low/out stock, or variant products), lowest first.
      case "stock_summary": {
        const { count } = await admin.from("products").select("id", { count: "exact", head: true });
        const cols = "id,name,category,stock_count,available,flavors,barcode,barcodes,price,extra,created_at";
        const flat = await admin.from("products").select(cols)
          .or("stock_count.lte.99,available.eq.false,stock_count.is.null")
          .order("stock_count", { ascending: true, nullsFirst: false }).limit(400);
        if (flat.error) return json({ error: flat.error.message }, 400);
        return json({ ok: true, total: count ?? 0, products: flat.data ?? [] });
      }
      // ---- Sales records (staff) ----
      // Save a finished sale + its stock log + the daily tally. Safe to repeat for the same id.
      case "record_sale": {
        const sale = { ...(body.sale ?? {}), cashierUid: uid };
        if (!body.id || !Array.isArray(sale.items) || sale.items.length === 0 || sale.items.length > 100) {
          return json({ error: "bad_request" }, 400);
        }
        if (!["cash", "gcash"].includes(sale.paymentMethod) || !(Number(sale.total) >= 0)) {
          return json({ error: "bad_request" }, 400);
        }
        const { data, error } = await admin.rpc("record_sale", {
          sale_id: String(body.id), sale, movements: body.movements ?? [], d: body.day ?? null, u: body.units ?? {}
        });
        if (error) return json({ error: error.message }, 409);
        return json({ ok: true, result: data });
      }
      case "get_sale": {
        const { data, error } = await admin.from("pos_sales").select("*").eq("id", String(body.id)).maybeSingle();
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, sale: data });
      }
      // Sales in a time range, newest first, in pages. body: { from, to, offset, limit }
      case "list_sales": {
        const lim = Math.min(Math.max(Number(body.limit) || 1000, 1), 1000);
        const offset = Math.max(0, Number(body.offset) || 0);
        let q = admin.from("pos_sales").select("*");
        if (body.from) q = q.gte("created_at", body.from);
        if (body.to) q = q.lt("created_at", body.to);
        const { data, error } = await q.order("created_at", { ascending: false }).range(offset, offset + lim - 1);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, sales: data ?? [], done: (data ?? []).length < lim });
      }
      // Save a refund/void. body: { saleId, expected, update, refund, refundId, movements }
      case "record_refund": {
        const refund = { ...(body.refund ?? {}), cashierUid: uid };
        const { data, error } = await admin.rpc("record_refund", {
          sale_id: String(body.saleId), expected: body.expected ?? null, upd: body.update ?? {},
          refund, refund_id: String(body.refundId), movements: body.movements ?? []
        });
        if (error) return json({ error: error.message }, 409);
        return json({ ok: true, result: data });
      }
      // One stock log line (manual edit, count, scanner sale). body: { movement, day, units }
      case "log_movement": {
        const m = body.movement ?? {};
        if (!["sale", "return", "count", "manual_edit"].includes(m.type)) return json({ error: "bad_request" }, 400);
        const { error } = await admin.from("stock_movements").insert({
          id: crypto.randomUUID(), product_id: m.productId ?? null, product_name: m.productName ?? null,
          variant_name: m.variantName || null, type: m.type,
          previous_stock: m.previousStock ?? null, new_stock: m.newStock ?? null,
          unit_price: typeof m.unitPrice === "number" ? m.unitPrice : null,
          performed_by_email: m.performedByEmail ?? null, performed_by_role: role
        });
        if (error) return json({ error: error.message }, 400);
        if (m.type === "sale" && body.day && body.units) await admin.rpc("bump_daily", { d: body.day, u: body.units });
        return json({ ok: true });
      }
      // Stock log. body: { type?, from?, to?, offset, limit }  (newest first)
      case "list_movements": {
        const lim = Math.min(Math.max(Number(body.limit) || 1000, 1), 1000);
        const offset = Math.max(0, Number(body.offset) || 0);
        let q = admin.from("stock_movements").select("*");
        if (body.type) q = q.eq("type", String(body.type));
        if (body.from) q = q.gte("created_at", body.from);
        if (body.to) q = q.lt("created_at", body.to);
        const { data, error } = await q.order("created_at", { ascending: false }).range(offset, offset + lim - 1);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, movements: data ?? [], done: (data ?? []).length < lim });
      }
      // Daily tallies from a day on. body.fromDay = "2026-09-01"
      case "list_daily": {
        const { data, error } = await admin.from("sales_daily").select("*").gte("day", String(body.fromDay ?? "0000")).order("day");
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, days: data ?? [] });
      }
      // Newest staff notifications. body.limit (default 100)
      case "list_notifications": {
        const lim = Math.min(Math.max(Number(body.limit) || 100, 1), 200);
        const { data, error } = await admin.from("staff_notifications").select("id,created_at,message,data")
          .order("created_at", { ascending: false }).limit(lim);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, notifications: data ?? [] });
      }
      // Create or edit products. body.items = [{ id, fields, create? }] (up to 500).
      // Admins can change anything; employees only stock and barcode fields.
      case "patch_products": {
        const items: any[] = Array.isArray(body.items) ? body.items.slice(0, 500) : [];
        if (items.length === 0) return json({ ok: true, products: [] });
        if (role !== "admin") {
          for (const it of items) {
            if (it.create || Object.keys(it.fields ?? {}).some((k) => !STAFF_FIELDS.includes(k))) {
              return json({ error: "admin_only" }, 403);
            }
          }
        }
        const ids = items.map((it) => String(it.id));
        const { data: rows, error: e1 } = await admin.from("products").select("*").in("id", ids);
        if (e1) return json({ error: e1.message }, 400);
        const { data: wsRows } = await admin.from("product_wholesale").select("*").in("product_id", ids);
        const rowById = new Map<string, any>((rows ?? []).map((r: any) => [r.id, r]));
        const wsById = new Map<string, any>((wsRows ?? []).map((r: any) => [r.product_id, r]));

        const newRows: any[] = [], newWs: any[] = [], result: any[] = [];
        for (const it of items) {
          const id = String(it.id);
          const existing = rowById.get(id);
          if (!existing && !it.create) continue; // edited a product that no longer exists
          const base = existing ?? { id, name: "", category: "", price: 0, stock_count: null, available: true,
            barcode: null, sku: null, barcodes: [], flavors: [], extra: {} };
          const { row, wholesale } = applyFields(base, wsById.get(id), it.fields ?? {});
          const { search_text: _s, created_at: _c, ...clean } = row;
          newRows.push({ ...clean, updated_at: new Date().toISOString() });
          newWs.push({ product_id: id, ...wholesale });
          result.push({ ...row, wholesale_price: wholesale.wholesale_price, variant_prices: wholesale.variant_prices });
        }
        if (newRows.length) {
          const r1 = await admin.from("products").upsert(newRows);
          if (r1.error) return json({ error: r1.error.message }, 400);
          const r2 = await admin.from("product_wholesale").upsert(newWs);
          if (r2.error) return json({ error: r2.error.message }, 400);
        }
        return json({ ok: true, products: result });
      }
      // Scanner stock change, all or nothing. body: { id, barcode, mode: "sale"|"count", value }
      case "scan_stock": {
        const { data, error } = await admin.rpc("scan_stock", {
          pid: body.id, code: body.barcode, mode: body.mode === "sale" ? "sale" : "count", val: Number(body.value)
        });
        if (error) return json({ error: error.message }, 409);
        return json({ ok: true, result: data });
      }
      // ---- Cashier reads (staff only). Each returns products WITH their wholesale prices. ----
      // Find products by words in the name or a variant name. body.term
      case "search": {
        const words = String(body.term ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
        if (words.length === 0) return json({ ok: true, products: [] });
        let q = admin.from("products").select("*");
        for (const w of words) q = q.ilike("search_text", `%${w.replace(/[%_\\]/g, "\\$&")}%`);
        const { data, error } = await q.order("name").limit(Math.min(Number(body.limit) || 40, 80));
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, products: await withWholesale(data ?? []) });
      }
      // Find the product(s) holding a scanned barcode. body.code
      case "lookup_barcode": {
        const code = String(body.code ?? "").trim();
        if (!code) return json({ ok: true, products: [] });
        let { data, error } = await admin.from("products").select("*").contains("barcodes", [code]).limit(3);
        if (error) return json({ error: error.message }, 400);
        if (!data || data.length === 0) {
          const r = await admin.from("products").select("*").or(`barcode.eq.${code},sku.eq.${code}`).limit(3);
          data = r.data ?? [];
        }
        return json({ ok: true, products: await withWholesale(data) });
      }
      // Fresh copies of specific products (cart refresh, price check before a sale). body.ids
      case "get_products": {
        const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200) : [];
        if (ids.length === 0) return json({ ok: true, products: [] });
        const { data, error } = await admin.from("products").select("*").in("id", ids);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, products: await withWholesale(data ?? []) });
      }
      // Staff only: read wholesale prices (they're not public). body.ids = [...]
      case "get_wholesale": {
        const { data, error } = await admin.from("product_wholesale").select("*").in("product_id", body.ids ?? []);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, rows: data });
      }
      default:
        return json({ error: "unknown_action" }, 400);
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
