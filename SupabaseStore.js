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
    flavors
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
