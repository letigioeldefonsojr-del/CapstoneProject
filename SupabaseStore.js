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

// A new product id (same style as before: 20 random letters and digits).
export function newProductId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}
