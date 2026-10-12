import { db } from "./firebase-config.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ====================================================================
// SHARED PRODUCT CACHE
// ----------------------------------------------------------------
// getProducts() returns the whole products list, reading Firestore
// only when it has to. Three layers, fastest first:
//   1. memory      — instant, lasts while the page stays open
//   2. IndexedDB   — survives page changes; has room for thousands of
//                    products (sessionStorage's ~5 MB limit silently
//                    failed once the catalog got big)
//   3. Firestore   — the real read (costs one read per product)
// Two callers asking at the same moment share ONE Firestore read.
// Stock changes can take up to CACHE_TTL_MS to show on another page;
// call invalidateProductsCache() after any write to force a fresh read.
// ====================================================================
const PRODUCTS_COLLECTION = "products";
const CACHE_TTL_MS = 90000; // 90 seconds
const DB_NAME = "almares_cache";
const STORE = "kv";
const KEY = "products";

let memory = null;       // { timestamp, products }
let inflight = null;     // shared in-progress Firestore read
let pendingClear = null; // IndexedDB delete that must finish before a read
let generation = 0;      // bumps on invalidate so stale reads aren't cached

export async function getProducts() {
  if (memory && Date.now() - memory.timestamp <= CACHE_TTL_MS) return memory.products;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      if (pendingClear) await pendingClear;
      const fromDisk = await idbRead();
      if (fromDisk && Date.now() - fromDisk.timestamp <= CACHE_TTL_MS) {
        memory = fromDisk;
        return fromDisk.products;
      }
      const startedAt = generation;
      const snap = await getDocs(collection(db, PRODUCTS_COLLECTION));
      const products = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (startedAt === generation) {
        memory = { timestamp: Date.now(), products };
        idbWrite(memory);
      }
      return products;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function invalidateProductsCache() {
  memory = null;
  generation++;
  pendingClear = idbDelete().finally(() => { pendingClear = null; });
  try { sessionStorage.removeItem("almares_products_cache"); } catch (e) { /* ignore */ }
}

// ---- IndexedDB helpers: every failure just means "no disk cache" ----
function openDb() {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  });
}

async function idbRead() {
  try {
    const d = await openDb();
    return await new Promise((resolve) => {
      const r = d.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  } catch (e) { return null; }
}

async function idbWrite(value) {
  try {
    const d = await openDb();
    d.transaction(STORE, "readwrite").objectStore(STORE).put(value, KEY);
  } catch (e) { console.error("Couldn't cache products:", e); }
}

async function idbDelete() {
  try {
    const d = await openDb();
    await new Promise((resolve) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    });
  } catch (e) { /* ignore */ }
}
