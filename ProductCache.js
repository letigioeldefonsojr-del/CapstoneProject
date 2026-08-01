import { db } from "./firebase-config.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ====================================================================
// SHARED PRODUCT CACHE
// ----------------------------------------------------------------
// Why this exists: without it, a single Dashboard page load fetches
// the entire "products" collection TWICE (once for the sidebar's
// low-stock badge, once for the stat cards) — and clicking over to
// Inventory fetches it a third time. That's the main thing making
// things feel slow, not the UI rendering.
//
// getProducts() caches the result in sessionStorage for CACHE_TTL_MS.
// Any caller within that window gets the cached array back instantly
// with zero network round-trip. Stock changes will take up to
// CACHE_TTL_MS to show up elsewhere as a result — that's the
// deliberate tradeoff for speed. Call invalidateProductsCache() after
// any action that changes stock (once Inventory management exists)
// to force the next read to be fresh.
// ====================================================================
const PRODUCTS_COLLECTION = "products";
const CACHE_KEY = "almares_products_cache";
const CACHE_TTL_MS = 45000; // 45 seconds

export async function getProducts() {
  const cached = readCache();
  if (cached) return cached;

  const snap = await getDocs(collection(db, PRODUCTS_COLLECTION));
  const products = snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));
  writeCache(products);
  return products;
}

export function invalidateProductsCache() {
  sessionStorage.removeItem(CACHE_KEY);
}

function readCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { timestamp, products } = JSON.parse(raw);
    if (Date.now() - timestamp > CACHE_TTL_MS) return null;
    return products;
  } catch (error) {
    return null;
  }
}

function writeCache(products) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), products }));
  } catch (error) {
    console.error("Couldn't cache products:", error);
  }
}
