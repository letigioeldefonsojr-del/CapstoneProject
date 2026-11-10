// stock-alerts — Low and out-of-stock alert detection.

const LOW_STOCK_THRESHOLD = 99;
const CRITICAL_STOCK_THRESHOLD = 49;

export function isProductInAlertState(product) {
  return getWorstAlertDetail(product) !== null;
}

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
