// product-index — Search fields stored on products for fast Cashier search.

const MIN_TOKEN = 2;     // shortest beginning that is stored / searched
const MAX_TOKEN = 15;    // longest beginning that is stored / searched
const MAX_TOKENS = 250;  // safety cap per product
const MAX_CODES = 60;

function words(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function codeOf(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function variantList(product) {
  return Array.isArray(product?.flavors) ? product.flavors : [];
}

export function buildSearchFields(product) {
  const codes = new Set();
  const addCode = (value) => { const c = codeOf(value); if (c) codes.add(c); };

  addCode(product?.barcode);
  addCode(product?.sku);

  const tokens = new Set();
  const addWords = (text) => {
    words(text).forEach((word) => {
      if (word.length < MIN_TOKEN) return;
      const longest = Math.min(word.length, MAX_TOKEN);
      for (let n = MIN_TOKEN; n <= longest; n++) tokens.add(word.slice(0, n));
    });
  };

  addWords(product?.name);
  variantList(product).forEach((variant) => {
    if (variant && typeof variant === "object") {
      addCode(variant.barcode);
      addCode(variant.sku);
      addWords(variant.name || variant.flavor || variant.label);
    }
  });

  return {
    barcodes: [...codes].slice(0, MAX_CODES),
    searchTokens: [...tokens].slice(0, MAX_TOKENS)
  };
}

function sameList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((value, i) => value === y[i]);
}

// True when a stored product is missing these fields or they are out of date.
export function needsIndexUpdate(product) {
  const wanted = buildSearchFields(product);
  return !sameList(product?.barcodes, wanted.barcodes) || !sameList(product?.searchTokens, wanted.searchTokens);
}

export function queryToken(term) {
  const list = words(term).filter((w) => w.length >= MIN_TOKEN);
  if (list.length === 0) return null;
  const longest = list.reduce((best, w) => (w.length > best.length ? w : best), "");
  return longest.slice(0, MAX_TOKEN);
}
