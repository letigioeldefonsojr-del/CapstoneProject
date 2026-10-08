// ====================================================================
// CASHIER LOGIC (pure functions — no Firebase, no DOM)
// ----------------------------------------------------------------
// Everything the counter POS decides lives here so it can be tested on
// its own: what price an item sells at right now (retail, discounted,
// or wholesale), how the cart adds up, and exactly how stock changes
// when a sale is completed.
//
// PRICING RULES (match the rest of the system):
//   - Prices are stored as text like "₱45.00" — parsed to numbers here.
//   - Retail price: the discount (discountPercent + start/end dates) is
//     applied when it is active right now. Same rule as the customer app.
//   - Wholesale price: the product's/variant's own wholesalePrice per
//     unit. Discounts never apply to wholesale.
//   - Legacy discounted products (an old version rewrote `price` and
//     kept `originalPrice`) already hold the discounted price — used
//     as is.
// ====================================================================
import { fuzzyMatch } from "./FuzzySearch.js";

export const F = {
  name: "name",
  price: "price",
  wholesale: "wholesalePrice",
  stock: "stockCount",          // product's own stock
  variantStock: "stock",        // a variant's stock
  variants: "flavors",
  available: "available",
  barcode: "barcode",
  image: "imageUrl",
  category: "category",
  discountPercent: "discountPercent",
  discountStart: "discountStart",
  discountEnd: "discountEnd",
  legacyOriginal: "originalPrice"
};

export const MAX_CART_LINES = 100;

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function parsePrice(value) {
  if (typeof value === "number") return isNaN(value) ? null : value;
  const parsed = parseFloat(String(value ?? "").replace(/[^\d.]/g, ""));
  return isNaN(parsed) ? null : parsed;
}

export function formatMoney(n) {
  return `₱${Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Real Timestamp, or the {seconds} object a Timestamp becomes after the
// sessionStorage product cache.
export function timeValueToMillis(value) {
  if (value === null || value === undefined) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return isNaN(parsed) ? null : parsed;
}

export function getVariants(product) {
  return Array.isArray(product[F.variants]) ? product[F.variants] : [];
}

function isVariantObject(v) {
  return v !== null && typeof v === "object";
}

// "none" | "scheduled" | "active" | "ended"
export function getDiscountState(product, now = Date.now()) {
  const percent = product[F.discountPercent];
  if (typeof percent !== "number" || percent <= 0) return "none";
  const start = timeValueToMillis(product[F.discountStart]);
  const end = timeValueToMillis(product[F.discountEnd]);
  if (start !== null && now < start) return "scheduled";
  if (end !== null && now > end) return "ended";
  return "active";
}

function isLegacyDiscounted(product) {
  return Boolean(product[F.legacyOriginal])
    || getVariants(product).some((v) => isVariantObject(v) && v[F.legacyOriginal]);
}

// -> { unit, regular, percent }   percent is null when nothing applies
export function retailPrice(regular, product, now = Date.now()) {
  if (regular === null || regular === undefined) return { unit: null, regular: null, percent: null };
  if (isLegacyDiscounted(product)) return { unit: regular, regular, percent: null };
  if (getDiscountState(product, now) !== "active") return { unit: regular, regular, percent: null };
  const percent = product[F.discountPercent];
  return { unit: round2(Math.round(regular * (100 - percent)) / 100), regular, percent };
}

function stockStatus(stock, available) {
  if (available === false) return false;
  if (typeof stock !== "number") return false; // stock not set — can't sell what isn't tracked
  return stock > 0;
}

// One sellable thing: a plain product, or one variant of a product.
export function candidatesForProduct(product, now = Date.now()) {
  const variants = getVariants(product).filter(isVariantObject);
  const productName = product[F.name] || "Unnamed product";
  const parentRegular = parsePrice(product[F.price]);
  const parentWholesale = parsePrice(product[F.wholesale]);

  if (variants.length === 0) {
    const retail = retailPrice(parentRegular, product, now);
    const stock = typeof product[F.stock] === "number" ? product[F.stock] : null;
    return [{
      key: `${product.id}|`,
      productId: product.id,
      variantName: null,
      barcode: product[F.barcode] || null,
      name: productName,
      productName,
      category: product[F.category] || "",
      imageUrl: product[F.image] || null,
      stock,
      inStock: stockStatus(stock, product[F.available]),
      retailUnit: retail.unit,
      regularUnit: retail.regular,
      discountPercent: retail.percent,
      wholesaleUnit: parentWholesale
    }];
  }

  return variants.map((variant) => {
    const variantName = variant.name || variant.flavor || variant.label || "Variant";
    const regular = parsePrice(variant[F.price]) ?? parentRegular;
    const retail = retailPrice(regular, product, now);
    const stock = typeof variant[F.variantStock] === "number" ? variant[F.variantStock] : null;
    return {
      key: `${product.id}|${variantName}`,
      productId: product.id,
      variantName,
      barcode: variant[F.barcode] || null,
      name: `${productName} — ${variantName}`,
      productName,
      category: product[F.category] || "",
      imageUrl: variant[F.image] || product[F.image] || null,
      stock,
      inStock: stockStatus(stock, variant[F.available]),
      retailUnit: retail.unit,
      regularUnit: retail.regular,
      discountPercent: retail.percent,
      wholesaleUnit: parsePrice(variant[F.wholesale]) ?? parentWholesale
    };
  });
}

export function findCandidateByBarcode(products, barcode, now = Date.now()) {
  const code = String(barcode || "").trim();
  if (!code) return null;
  for (const product of products) {
    const hit = candidatesForProduct(product, now).find((c) => c.barcode === code);
    if (hit) return hit;
  }
  return null;
}

// Products whose name (or any variant name) matches the typed text.
export function searchProducts(products, term, limit = 30) {
  const q = String(term || "").trim();
  if (!q) return [];
  return products
    .filter((p) => {
      if (fuzzyMatch(q, p[F.name] || "")) return true;
      return getVariants(p).some((v) => isVariantObject(v) && fuzzyMatch(q, v.name || ""));
    })
    .sort((a, b) => (a[F.name] || "").localeCompare(b[F.name] || ""))
    .slice(0, limit);
}

// ---------------------------- CART ----------------------------------
// A cart is a plain array of lines. Every function returns a NEW array
// (plus an optional error message) and never mutates its input.

export function lineUnitPrice(line) {
  if (line.mode === "wholesale" && line.wholesaleUnit !== null && line.wholesaleUnit !== undefined) {
    return line.wholesaleUnit;
  }
  return line.retailUnit;
}

export function lineTotal(line) {
  const unit = lineUnitPrice(line);
  return unit === null || unit === undefined ? 0 : round2(unit * line.qty);
}

export function cartTotal(cart) {
  return round2(cart.reduce((sum, line) => sum + lineTotal(line), 0));
}

export function cartUnits(cart) {
  return cart.reduce((sum, line) => sum + line.qty, 0);
}

export function addToCart(cart, candidate, qty = 1) {
  if (!candidate.inStock) return { cart, error: `"${candidate.name}" is out of stock.` };
  if (candidate.retailUnit === null || candidate.retailUnit === undefined) {
    return { cart, error: `"${candidate.name}" has no retail price set.` };
  }

  const existing = cart.find((l) => l.key === candidate.key);
  if (existing) {
    const nextQty = existing.qty + qty;
    if (nextQty > candidate.stock) {
      return { cart, error: `Only ${candidate.stock} of "${candidate.name}" in stock.` };
    }
    return { cart: cart.map((l) => (l.key === candidate.key ? { ...l, qty: nextQty } : l)) };
  }

  if (cart.length >= MAX_CART_LINES) return { cart, error: `A sale can have at most ${MAX_CART_LINES} different items.` };
  if (qty > candidate.stock) return { cart, error: `Only ${candidate.stock} of "${candidate.name}" in stock.` };

  return {
    cart: [...cart, {
      key: candidate.key,
      productId: candidate.productId,
      variantName: candidate.variantName,
      barcode: candidate.barcode,
      name: candidate.name,
      productName: candidate.productName,
      imageUrl: candidate.imageUrl,
      stock: candidate.stock,
      retailUnit: candidate.retailUnit,
      regularUnit: candidate.regularUnit,
      discountPercent: candidate.discountPercent,
      wholesaleUnit: candidate.wholesaleUnit,
      mode: "retail",
      qty
    }]
  };
}

export function setLineQty(cart, key, qty) {
  const n = Math.floor(Number(qty));
  if (!Number.isFinite(n) || n < 1) return { cart, error: "Quantity must be at least 1." };
  const line = cart.find((l) => l.key === key);
  if (!line) return { cart };
  if (n > line.stock) {
    return { cart: cart.map((l) => (l.key === key ? { ...l, qty: line.stock } : l)), error: `Only ${line.stock} of "${line.name}" in stock.` };
  }
  return { cart: cart.map((l) => (l.key === key ? { ...l, qty: n } : l)) };
}

export function setLineMode(cart, key, mode) {
  const line = cart.find((l) => l.key === key);
  if (!line) return { cart };
  if (mode === "wholesale" && (line.wholesaleUnit === null || line.wholesaleUnit === undefined)) {
    return { cart, error: `"${line.name}" has no wholesale price set.` };
  }
  return { cart: cart.map((l) => (l.key === key ? { ...l, mode } : l)) };
}

export function removeLine(cart, key) {
  return cart.filter((l) => l.key !== key);
}

// ---------------------------- PAYMENT -------------------------------
export const PAYMENT_METHODS = ["cash", "gcash"];

export function computePayment(total, method, tendered) {
  if (!PAYMENT_METHODS.includes(method)) return { ok: false, error: "Choose Cash or GCash." };
  if (method === "gcash") return { ok: true, tendered: total, change: 0 };

  const received = Number(tendered);
  if (tendered === "" || tendered === null || tendered === undefined || !Number.isFinite(received)) {
    return { ok: false, error: "Enter the cash received.", change: 0 };
  }
  if (received < total) {
    return { ok: false, error: `Cash received is short by ${formatMoney(round2(total - received))}.`, change: 0 };
  }
  return { ok: true, tendered: round2(received), change: round2(received - total) };
}

// ----------------------- STOCK / MOVEMENT PLAN -----------------------
// Given each product's FRESH data (read inside the transaction) and the
// cart lines, works out the new stock for every affected product and
// the stock-log entries to write. Returns { error } if any line can no
// longer be fulfilled.
export function planStockUpdates(freshProductsById, lines) {
  const working = new Map();       // productId -> { stockCount?, flavors? } working copy
  const updates = new Map();       // productId -> update object
  const movements = [];

  for (const line of lines) {
    const data = freshProductsById.get(line.productId);
    if (!data) return { error: `"${line.name}" no longer exists.` };

    const state = working.get(line.productId) || {
      stockCount: data[F.stock],
      flavors: Array.isArray(data[F.variants]) ? data[F.variants].map((v) => (isVariantObject(v) ? { ...v } : v)) : null
    };
    working.set(line.productId, state);

    if (line.variantName === null) {
      const current = typeof state.stockCount === "number" ? state.stockCount : 0;
      if (current < line.qty) return { error: `Only ${current} left of "${line.name}" — can't sell ${line.qty}.` };
      const next = current - line.qty;
      state.stockCount = next;
      updates.set(line.productId, { ...(updates.get(line.productId) || {}), [F.stock]: next, [F.available]: next > 0 });
      movements.push({ productId: line.productId, productName: line.productName, variantName: null, previousStock: current, newStock: next, unitPrice: lineUnitPrice(line) });
      continue;
    }

    if (!state.flavors) return { error: `"${line.name}" is no longer a variant product.` };
    const idx = state.flavors.findIndex((v) => {
      if (!isVariantObject(v)) return false;
      const name = v.name || v.flavor || v.label;
      if (name !== line.variantName) return false;
      return !line.barcode || !v[F.barcode] || v[F.barcode] === line.barcode;
    });
    if (idx === -1) return { error: `"${line.name}" is no longer available.` };

    const variant = state.flavors[idx];
    const current = typeof variant[F.variantStock] === "number" ? variant[F.variantStock] : 0;
    if (current < line.qty) return { error: `Only ${current} left of "${line.name}" — can't sell ${line.qty}.` };
    const next = current - line.qty;
    state.flavors[idx] = { ...variant, [F.variantStock]: next, [F.available]: next > 0 };
    updates.set(line.productId, { ...(updates.get(line.productId) || {}), [F.variants]: state.flavors });
    movements.push({ productId: line.productId, productName: line.productName, variantName: line.variantName, previousStock: current, newStock: next, unitPrice: lineUnitPrice(line) });
  }

  return { updates, movements };
}

// ----------------------------- SALE DOC ------------------------------
export function makeReceiptNo(date = new Date(), random = Math.random) {
  const pad = (n) => String(n).padStart(2, "0");
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const suffix = Math.floor(random() * 36 ** 4).toString(36).toUpperCase().padStart(4, "0");
  return `POS-${day}-${suffix}`;
}

export function buildSaleItems(cart) {
  return cart.map((line) => ({
    productId: line.productId,
    productName: line.productName,
    variantName: line.variantName,
    barcode: line.barcode || null,
    qty: line.qty,
    priceMode: line.mode,
    unitPrice: lineUnitPrice(line),
    regularUnitPrice: line.regularUnit ?? null,
    discountPercent: line.mode === "retail" ? (line.discountPercent ?? null) : null,
    lineTotal: lineTotal(line)
  }));
}
