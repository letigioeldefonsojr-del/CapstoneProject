// ====================================================================
// STOCK ALERT DETECTION (shared, variant-aware)
// ----------------------------------------------------------------
// Was previously duplicated (and wrong the same way) in three
// separate places — Sidebar.js's badge count, Notifications.js's
// list, and Dashboard.js's recent notifications — all only checking
// the PARENT product's flat stockCount field. For a variant product
// (different sizes/flavors, stock tracked per-variant instead), that
// parent field is empty, so a variant genuinely at 0 stock was never
// detected as an alert at all, regardless of how low it actually was.
//
// Checks each variant's OWN stock individually when variants exist —
// same logic Inventory.js's own table already correctly uses (see
// buildVariantSummaryBadge there), just centralized here so every
// consumer agrees on the same, correct answer.
// ====================================================================
const LOW_STOCK_THRESHOLD = 99;
const CRITICAL_STOCK_THRESHOLD = 49;

// Simple boolean — used where only "does this need a badge count"
// matters, not the specific severity/number (Sidebar.js's badge).
export function isProductInAlertState(product) {
  return getWorstAlertDetail(product) !== null;
}

// Full detail — used where the actual message needs to say WHICH
// severity and how many are left (Notifications.js, Dashboard.js).
// Returns null if the product (all its variants, if any) is fully
// in-stock. For a variant product with multiple variants in alert
// states, reports the SINGLE worst one — matches how Inventory's own
// table already summarizes a variant product with one badge.
export function getWorstAlertDetail(product) {
  const variants = Array.isArray(product.flavors) ? product.flavors : [];

  if (variants.length > 0) {
    const priority = ["out", "critical", "low", "unknown"];
    const withStatus = variants
      .map((variant) => ({ variant, status: getStockStatus(variant?.stock, variant?.available) }))
      .filter((entry) => entry.status !== "in");

    for (const tier of priority) {
      const match = withStatus.find((entry) => entry.status === tier);
      if (match) {
        return { status: tier, stock: match.variant.stock, variantLabel: match.variant.name || null };
      }
    }
    return null; // every variant is "in"
  }

  const status = getStockStatus(product.stockCount, product.available);
  if (status === "in") return null;
  return { status, stock: product.stockCount, variantLabel: null };
}

function getStockStatus(stock, available) {
  if (available === false || stock === 0) return "out";
  if (typeof stock !== "number") return "unknown";
  if (stock <= CRITICAL_STOCK_THRESHOLD) return "critical";
  if (stock <= LOW_STOCK_THRESHOLD) return "low";
  return "in";
}
