import { auth } from "./firebase-config.js";
import { SUPABASE_URL, SUPABASE_KEY } from "./SupabaseConfig.js";

// ====================================================================
// SUPABASE STORE (talks to the store-api function)
// ----------------------------------------------------------------
// Every call sends the signed-in person's Firebase login; the function
// checks it and that the person is staff. Products come back already
// reshaped into the same form the Cashier has always used (prices as
// "₱45.00", stockCount, flavors...), so the rest of the Cashier code
// does not need to know where they came from.
// ====================================================================
const money = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? null : `₱${Number(n).toFixed(2)}`);

export class StoreError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

async function call(action, payload = {}) {
  const user = auth.currentUser;
  if (!user) throw new StoreError("not_signed_in", "You are signed out. Please sign in again.");
  const token = await user.getIdToken();
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/store-api`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_KEY,
        "x-firebase-token": token
      },
      body: JSON.stringify({ action, ...payload })
    });
  } catch (error) {
    throw new StoreError("network", "Couldn't reach the product database. Check the connection.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok || !data || data.error) {
    throw new StoreError(data?.error || `http_${res.status}`, data?.error || `The product database returned ${res.status}.`);
  }
  return data;
}

// A Supabase row -> the product shape the Cashier works with.
export function rowToProduct(row) {
  const variantPrices = row.variant_prices || {};
  const flavors = Array.isArray(row.flavors) ? row.flavors.map((v) => {
    if (!v || typeof v !== "object") return v;
    const name = v.name || v.flavor || v.label;
    const ws = variantPrices[name];
    return { ...v, price: money(v.price), wholesalePrice: ws === undefined || ws === null ? null : money(ws) };
  }) : [];
  const hasVariants = flavors.length > 0;
  return {
    ...(row.extra || {}),
    id: row.id,
    name: row.name,
    category: row.category,
    price: hasVariants ? null : money(row.price),
    wholesalePrice: hasVariants ? null : money(row.wholesale_price),
    stockCount: row.stock_count,
    available: row.available,
    barcode: row.barcode || null,
    barcodes: row.barcodes || [],
    flavors,
    createdAt: row.created_at ? { seconds: Math.floor(Date.parse(row.created_at) / 1000), nanoseconds: 0 } : undefined
  };
}

export async function searchProducts(term, limit = 40) {
  const data = await call("search", { term, limit });
  return data.products.map(rowToProduct);
}

export async function lookupBarcode(code) {
  const data = await call("lookup_barcode", { code });
  return data.products.map(rowToProduct);
}

export async function getProductsByIds(ids) {
  if (!ids.length) return [];
  const data = await call("get_products", { ids });
  return data.products.map(rowToProduct);
}

// lines: [{ productId, variantName|null, qty }]
const toItems = (lines) => lines.map((l) => ({ id: l.productId, variant: l.variantName ?? null, qty: l.qty }));

// Deducts stock for a sale in one all-or-nothing step. Returns the stock
// left per line (same order as the lines).
export async function applySale(lines, ref) {
  const data = await call("apply_sale", { items: toItems(lines), ref: ref || null });
  return data.updated;
}

export async function restock(lines) {
  const data = await call("restock", { items: toItems(lines) });
  return data.updated;
}

export async function linkBarcode(productId, barcode, variantName) {
  await call("link_barcode", { id: productId, barcode, variant: variantName || null });
}

// ----------------------------- INVENTORY -------------------------------
// Edits are written with the app's usual field names. Firebase's special
// values (timestamps, "delete this field", "server time") are turned into
// plain data the function understands.
function toWire(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(toWire);
  if (typeof value === "object") {
    const method = value._methodName;
    if (method === "deleteField") return "__delete__";
    if (method === "serverTimestamp") return "__now__";
    if (typeof value.toMillis === "function" && typeof value.seconds === "number") {
      return { seconds: value.seconds, nanoseconds: value.nanoseconds || 0 };
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = toWire(v);
    return out;
  }
  return value;
}

// Every product, fetched in pages. (Supabase does not bill per row read.)
export async function listAllProducts() {
  const all = [];
  for (let offset = 0; offset < 100000; offset += 1000) {
    const data = await call("list_products", { offset, limit: 1000 });
    all.push(...data.products.map(rowToProduct));
    if (data.done) break;
  }
  return all;
}

// items: [{ id, fields, create? }]. Returns the saved products.
export async function patchProducts(items) {
  const saved = [];
  for (let i = 0; i < items.length; i += 400) {
    const chunk = items.slice(i, i + 400).map((it) => ({ id: it.id, create: !!it.create, fields: toWire(it.fields) }));
    const data = await call("patch_products", { items: chunk });
    saved.push(...data.products.map(rowToProduct));
  }
  return saved;
}

export async function deleteProducts(ids) {
  for (let i = 0; i < ids.length; i += 500) {
    await call("delete_products", { ids: ids.slice(i, i + 500) });
  }
}

export async function scanStock(id, barcode, mode, value) {
  const data = await call("scan_stock", { id, barcode, mode, value });
  return data.result;
}

// Total product count + products that may need a stock alert (lowest first).
export async function stockSummary() {
  const data = await call("stock_summary");
  return { total: data.total, products: data.products.map(rowToProduct) };
}

// ----------------------------- SALES RECORDS ---------------------------
// Rows come back in the same shape the pages already use from Firebase
// (createdAt behaves like a Firebase timestamp: toMillis(), toDate()).
function stamp(iso) {
  const ms = Date.parse(iso);
  return { seconds: Math.floor(ms / 1000), nanoseconds: 0, toMillis: () => ms, toDate: () => new Date(ms) };
}
const num = (v) => (v === null || v === undefined ? null : Number(v));

export function saleFromRow(r) {
  return { ...(r.data || {}), id: r.id, createdAt: stamp(r.created_at) };
}
export function movementFromRow(r) {
  return {
    id: r.id, productId: r.product_id, productName: r.product_name, variantName: r.variant_name || null,
    type: r.type, previousStock: r.previous_stock, newStock: r.new_stock, unitPrice: num(r.unit_price),
    posSaleId: r.pos_sale_id || null, posRefundId: r.pos_refund_id || null,
    performedByEmail: r.performed_by_email, performedByRole: r.performed_by_role,
    createdAt: stamp(r.created_at)
  };
}

// Units sold per product from stock log lines ({productId, previousStock, newStock}).
export function unitsFromMovements(movements) {
  const units = {};
  (movements || []).forEach((m) => {
    const sold = (m.previousStock ?? 0) - (m.newStock ?? 0);
    if (m.productId && sold > 0) units[m.productId] = (units[m.productId] || 0) + sold;
  });
  return units;
}

// Saves a sale with its stock log lines and today's tally. Repeating the same id changes nothing.
export async function recordSale({ id, sale, movements, day }) {
  const lines = movements.map((m) => ({
    productId: m.productId, productName: m.productName, variantName: m.variantName ?? null,
    previousStock: m.previousStock, newStock: m.newStock, unitPrice: m.unitPrice ?? null
  }));
  await call("record_sale", { id, sale, movements: lines, day, units: unitsFromMovements(movements) });
}

export async function getSale(id) {
  const data = await call("get_sale", { id });
  return data.sale ? saleFromRow(data.sale) : null;
}

// Every sale between two dates, newest first.
export async function listSales(from, to) {
  const all = [];
  for (let offset = 0; offset < 200000; offset += 1000) {
    const data = await call("list_sales", {
      from: from ? from.toISOString() : null, to: to ? to.toISOString() : null, offset, limit: 1000
    });
    all.push(...data.sales.map(saleFromRow));
    if (data.done) break;
  }
  return all;
}

// refund: { total, reason, ... } as stored with the refund. Returns when saved.
export async function recordRefund({ saleId, expected, update, refund, refundId, movements }) {
  const lines = (movements || []).map((m) => ({
    productId: m.productId, productName: m.productName, variantName: m.variantName ?? null,
    previousStock: m.previousStock, newStock: m.newStock, unitPrice: m.unitPrice ?? null
  }));
  await call("record_refund", { saleId, expected: expected ?? null, update, refund, refundId, movements: lines });
}

// One stock log line from the Inventory page (manual edit, count, scanner sale).
export async function logMovement(m) {
  const body = { movement: m };
  if (m.type === "sale") {
    body.units = unitsFromMovements([m]);
    const d = new Date();
    body.day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  await call("log_movement", body);
}

// Stock log lines, newest first. opts: { type, from, to, limit }
export async function listMovements(opts = {}) {
  const out = [];
  const cap = opts.limit || 200000;
  for (let offset = 0; offset < cap; offset += 1000) {
    const data = await call("list_movements", {
      type: opts.type || null, from: opts.from ? opts.from.toISOString() : null,
      to: opts.to ? opts.to.toISOString() : null, offset, limit: Math.min(1000, cap - offset)
    });
    out.push(...data.movements.map(movementFromRow));
    if (data.done) break;
  }
  return out;
}

// Daily tallies from a day on: [{ date, units }]
export async function listDaily(fromDay) {
  const data = await call("list_daily", { fromDay });
  return data.days.map((d) => ({ date: d.day, units: d.units || {} }));
}

// A new product id (same style as before: 20 random letters and digits).
export function newProductId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}
