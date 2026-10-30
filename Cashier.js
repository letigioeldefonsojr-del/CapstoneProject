import { db } from "./firebase-config.js";
import {
  collection, doc, getDoc, runTransaction, serverTimestamp, getDocs, query, where, orderBy, limit, Timestamp, updateDoc, arrayUnion, writeBatch
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getProducts, primeProductsCache } from "./ProductCache.js?v=3";
import { queryToken } from "./ProductIndex.js";
import { recordSaleTally, dayKey } from "./SalesDaily.js?v=20261029b";
import { SUPABASE_ENABLED } from "./SupabaseConfig.js";
import * as SB from "./SupabaseStore.js?v=20261029c";
import {
  candidatesForProduct, findCandidateByBarcode, searchProducts,
  addToCart, setLineQty, setLineMode, removeLine,
  lineUnitPrice, lineTotal, cartTotal, cartUnits,
  computePayment, planStockUpdates, makeReceiptNo, buildSaleItems, formatMoney,
  itemRefundedQty, remainingQty, saleRefundStatus, planRefund, planRestock, round2,
  applyNumpadKey, quickCashAmounts
} from "./CashierLogic.js?v=20261009a";

// ====================================================================
// CASHIER (face-to-face counter POS)
// ----------------------------------------------------------------
// All the money/stock decisions are in CashierLogic.js (tested on its
// own). This file is the screen plus the one Firestore transaction that
// completes a sale: it re-reads every product, re-checks stock and
// prices, then deducts stock, writes a posSales record and writes the
// stockMovements entries — all or nothing.
// ====================================================================
const STORE_NAME = "Almares 328";

let products = [];         // the working set: everything looked up or loaded so far
let indexed = false;       // true = products are found with database queries, not a full download
const seenAt = new Map();  // product id -> when this copy was fetched (to refresh old copies)
let cart = [];
let method = "cash";
let currentUser = null;
let currentRole = "employee";
let busy = false;
let lastLoadedAt = 0;      // last time anything was refreshed
let lastFullLoadAt = 0;    // last time the WHOLE catalog was downloaded
let searchTimer = null;
let saleCustomer = null;      // optional: who this sale is for (see CUSTOMER below)
let pendingCode = null;       // a scanned barcode the system doesn't know yet (link mode)

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

document.addEventListener("sidebar:ready", async (event) => {
  currentUser = event.detail.user;
  currentRole = event.detail.role || "employee";
  wireUi();
  wireHistory();
  await initCatalog();
  renderAll();
  loadHistory();
  focusScanInput();
});

// ----------------------------- SCANNER READY --------------------------
// The barcode scanner types like a keyboard, so the scan box must be the
// place keystrokes land without the cashier clicking it first. Three
// things make that work: focus it when the page opens (and when the window
// regains focus), and — as a safety net — send any typed character to it
// when focus is on the blank page or a button instead of a text field.
// On touch screens the box is not focused automatically (that would pop up
// the on-screen keyboard); a hardware scanner still works via the safety net.
function focusScanInput() {
  const input = $("pos-input");
  if (!input || IS_TOUCH) return;
  input.focus({ preventScroll: true });
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function anyModalOpen() {
  return Boolean(document.querySelector(".modal-overlay:not([hidden])"));
}

let lastScanAt = 0; // when the last scan was entered (used to keep the cursor in the scan box)

document.addEventListener("keydown", (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (isTypingTarget(event.target) || anyModalOpen()) return;
  if (event.key.length !== 1) return; // only characters (scanners type characters)
  const input = $("pos-input");
  if (input) input.focus({ preventScroll: true }); // the character then lands in the box
});

window.addEventListener("focus", () => { if (!anyModalOpen()) focusScanInput(); });
window.addEventListener("pageshow", () => focusScanInput());

// ------------------------- ON-DEMAND PRODUCT LOOKUP -------------------
// Once an admin has run "Prepare Cashier Search" in Inventory (it sets
// settings/productIndex), the Cashier no longer downloads the whole
// catalogue (one database read per product). It asks the database for just
// the product that was scanned or typed, which costs a few reads. Until
// that setup is done it keeps working the old way, so nothing breaks.
const FRESH_MS = 10 * 60000; // a looked-up product is re-fetched after 10 minutes
const SEARCH_LIMIT = 60;

async function initCatalog() {
  if (SUPABASE_ENABLED) { indexed = true; products = []; return; } // products are looked up in Supabase on demand
  try {
    const flag = await getDoc(doc(db, "settings", "productIndex"));
    indexed = flag.exists() && flag.data().ready === true;
  } catch (error) {
    console.error("Couldn't check the search setup:", error);
    indexed = false;
  }
  if (!indexed) await loadProducts();
  else products = [];
}

function mergeIntoWorkingSet(list) {
  const now = Date.now();
  list.forEach((product) => {
    const index = products.findIndex((p) => p.id === product.id);
    if (index >= 0) products[index] = product; else products.push(product);
    seenAt.set(product.id, now);
  });
}

async function fetchProducts(q) {
  const snap = await getDocs(q);
  const found = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  mergeIntoWorkingSet(found);
  return found;
}

function isFresh(candidate) {
  return Date.now() - (seenAt.get(candidate.productId) || 0) < FRESH_MS;
}

// A barcode is one run of letters/digits/dashes containing a digit, 6+ long.
function looksLikeCode(text) {
  return /^[A-Za-z0-9\-]{6,}$/.test(text) && /\d/.test(text);
}

// Finds a scanned code: in this session's working set first, then in the database.
async function lookupBarcode(code) {
  const local = findCandidateByBarcode(products, code);
  if (!indexed) return local;
  if (local && isFresh(local)) return local;
  if (SUPABASE_ENABLED) {
    // Errors are NOT swallowed here: "database unreachable" must not look like "unknown barcode".
    const found = await SB.lookupBarcode(code);
    mergeIntoWorkingSet(found);
    return findCandidateByBarcode(found, code) || local;
  }
  const col = collection(db, "products");
  const attempts = [
    where("barcodes", "array-contains", code), // all codes incl. variants
    where("barcode", "==", code),               // older products
    where("sku", "==", code)
  ];
  try {
    for (const condition of attempts) {
      const found = await fetchProducts(query(col, condition, limit(3)));
      const hit = findCandidateByBarcode(found, code);
      if (hit) return hit;
    }
  } catch (error) {
    console.error("Barcode lookup failed:", error);
  }
  return findCandidateByBarcode(products, code);
}

// Asks the database for products with a word starting like the typed text,
// then the usual fuzzy matching narrows it down on screen.
const searchedTokens = new Map(); // token -> when it was last searched
async function remoteSearch(term) {
  if (!indexed) return;
  if (/^\d{6,}$/.test(term)) return; // looks like a barcode, handled by lookupBarcode
  if (SUPABASE_ENABLED) {
    const key = term.toLowerCase();
    if (term.length < 2 || Date.now() - (searchedTokens.get(key) || 0) < 60000) return;
    searchedTokens.set(key, Date.now());
    try {
      mergeIntoWorkingSet(await SB.searchProducts(term, SEARCH_LIMIT));
    } catch (error) {
      console.error("Search failed:", error);
      searchedTokens.delete(key);
      showMessage(error.message || "Couldn't search the products.", true);
    }
    return;
  }
  const token = queryToken(term);
  if (!token) return;
  if (Date.now() - (searchedTokens.get(token) || 0) < 60000) return; // searched a moment ago
  searchedTokens.set(token, Date.now());
  try {
    await fetchProducts(query(collection(db, "products"), where("searchTokens", "array-contains", token), limit(SEARCH_LIMIT)));
  } catch (error) {
    console.error("Search failed:", error);
    searchedTokens.delete(token);
  }
}

// Keeps the shared saved copy of the catalog in step with this register's
// own sales and refunds, so coming back to this page (or opening another
// page that needs the products) within a few minutes costs no reads.
let primeTimer = null;
function saveProductsCopy() {
  if (indexed) return; // the working set is only part of the catalogue; never share it as if it were all
  clearTimeout(primeTimer);
  primeTimer = setTimeout(() => primeProductsCache(products), 1500);
}

async function loadProducts() {
  // Uses the saved copy when it is recent (10 minutes); otherwise downloads fresh.
  try {
    products = await getProducts();
    lastLoadedAt = Date.now();
    lastFullLoadAt = lastLoadedAt;
  } catch (error) {
    console.error("Couldn't load products:", error);
    showMessage("Couldn't load products. Check the connection and refresh.", true);
  }
}

// After a sale or refund we already know exactly which products changed,
// so the on-screen list is updated in place instead of re-downloading the
// whole catalog (which costs one database read per product).
function applyLocalUpdates(updates) {
  if (!updates) return;
  for (const [productId, update] of updates) {
    const product = products.find((p) => p.id === productId);
    if (product) Object.assign(product, update);
  }
  saveProductsCopy();
}

// Re-reads ONLY the products currently in the cart (a few reads), so a
// price or stock change on those still shows up.
async function refreshCartProducts() {
  const ids = [...new Set(cart.map((l) => l.productId))];
  if (SUPABASE_ENABLED) {
    try {
      const freshList = await SB.getProductsByIds(ids);
      const freshIds = new Set(freshList.map((p) => p.id));
      mergeIntoWorkingSet(freshList);
      ids.filter((id) => !freshIds.has(id)).forEach((id) => {
        const index = products.findIndex((p) => p.id === id);
        if (index >= 0) products.splice(index, 1);
      });
    } catch (error) {
      console.error("Couldn't refresh the cart products:", error);
    }
    lastLoadedAt = Date.now();
    return;
  }
  for (const id of ids) {
    try {
      const snap = await getDoc(doc(db, "products", id));
      const index = products.findIndex((p) => p.id === id);
      if (snap.exists()) {
        const fresh = { id, ...snap.data() };
        if (index >= 0) products[index] = fresh; else products.push(fresh);
        seenAt.set(id, Date.now());
      } else if (index >= 0) {
        products.splice(index, 1);
      }
    } catch (error) {
      console.error("Couldn't refresh a cart product:", error);
    }
  }
  lastLoadedAt = Date.now();
  saveProductsCopy();
}

// ----------------------------- UI WIRING ------------------------------
function wireUi() {
  const input = $("pos-input");

  input.addEventListener("input", () => {
    const value = input.value.trim();
    // A scanner types the whole code instantly; an exact barcode match
    // adds the item without needing Enter.
    if (value.length >= 4) {
      const hit = findCandidateByBarcode(products, value);
      if (hit) {
        add(hit);
        input.value = "";
        renderResults();
        return;
      }
    }
    clearTimeout(searchTimer);
    renderResults();
    if (indexed) {
      // Ask the database only after the typing pauses (a scanner types in an
      // instant, and may or may not press Enter at the end).
      searchTimer = setTimeout(async () => {
        const term = input.value.trim();
        if (!term) return;
        if (looksLikeCode(term)) {
          let hit = null;
          try {
            hit = await lookupBarcode(term);
          } catch (error) {
            console.error("Barcode lookup failed:", error);
            if (input.value.trim() === term) showMessage(error.message || "Couldn't look up the barcode.", true);
            return;
          }
          if (input.value.trim() !== term) return;
          if (hit) {
            add(hit);
            input.value = "";
            renderResults();
          } else if (/^\d{6,}$/.test(term)) {
            enterLinkMode(term);
          }
          return;
        }
        await remoteSearch(term);
        if (input.value.trim() === term) renderResults();
      }, 250);
    } else {
      searchTimer = setTimeout(renderResults, 120);
    }
  });

  // Some scanners end every scan with Tab instead of Enter. Tab would jump to the next
  // box (Customer), so a scan's Tab counts as Enter and the cursor stays here.
  input.addEventListener("keydown", async (event) => {
    if (event.key === "Tab" && !event.shiftKey) {
      if (!input.value.trim() && Date.now() - lastScanAt > 600) return; // a real Tab by hand still moves on
    } else if (event.key !== "Enter") return;
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    lastScanAt = Date.now();
    clearTimeout(searchTimer);
    input.value = ""; // cleared at once so the next scan can start while this one is looked up
    try {
      let hit = null;
      try {
        hit = await lookupBarcode(value);
      } catch (error) {
        console.error("Barcode lookup failed:", error);
        showMessage(error.message || "Couldn't look up the barcode.", true);
        return;
      }
      if (hit) {
        add(hit);
      } else if (looksLikeCode(value)) {
        enterLinkMode(value);
      } else {
        await remoteSearch(value);
        const first = searchProducts(products, value)
          .flatMap((p) => candidatesForProduct(p))
          .find((c) => c.inStock);
        if (first) add(first);
        else showMessage(`Nothing in stock matches "${value}".`, true);
      }
    } finally {
      renderResults();
    }
  });

  $("pos-results").addEventListener("click", async (event) => {
    if (event.target.closest("[data-link-cancel]")) {
      pendingCode = null;
      hideMessage();
      renderResults();
      input.focus({ preventScroll: true });
      return;
    }
    const linkBtn = event.target.closest("[data-link-key]");
    if (linkBtn) {
      const candidate = allCandidates().find((c) => c.key === linkBtn.dataset.linkKey);
      if (candidate) await linkBarcodeTo(candidate);
      input.focus({ preventScroll: true });
      return;
    }
    const btn = event.target.closest("[data-add-key]");
    if (!btn) return;
    const candidate = allCandidates().find((c) => c.key === btn.dataset.addKey);
    if (candidate) add(candidate);
    input.focus({ preventScroll: true });
  });

  $("pos-lines").addEventListener("click", (event) => {
    const el = event.target.closest("[data-action]");
    if (!el) return;
    const key = el.dataset.key;
    const line = cart.find((l) => l.key === key);
    if (!line) return;
    let result = { cart };
    if (el.dataset.action === "inc") result = setLineQty(cart, key, line.qty + 1);
    if (el.dataset.action === "dec") result = line.qty > 1 ? setLineQty(cart, key, line.qty - 1) : { cart };
    if (el.dataset.action === "remove") result = { cart: removeLine(cart, key) };
    if (el.dataset.action === "mode") result = setLineMode(cart, key, el.dataset.mode);
    applyCartResult(result);
  });

  $("pos-lines").addEventListener("click", (event) => {
    const el = event.target.closest("[data-qty-input]");
    if (el && IS_TOUCH) { el.blur(); openQtyPad(el.dataset.qtyInput); }
  });

  $("pos-lines").addEventListener("change", (event) => {
    const el = event.target.closest("[data-qty-input]");
    if (!el) return;
    applyCartResult(setLineQty(cart, el.dataset.qtyInput, el.value));
  });

  $("pos-method").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-method]");
    if (!btn) return;
    method = btn.dataset.method;
    document.querySelectorAll("#pos-method .tab-row__btn").forEach((b) => b.classList.toggle("is-active", b === btn));
    renderPayment();
  });

  // Cash received: typed on a keyboard, or tapped on the on-screen number
  // pad. inputmode="none" keeps the tablet's own keyboard from popping up.
  $("pos-tendered").addEventListener("input", () => {
    setTendered(sanitizeAmount($("pos-tendered").value));
  });
  buildNumpad($("pos-pay-pad"), {
    decimal: true,
    onKey: (key) => setTendered(applyNumpadKey($("pos-tendered").value, key))
  });
  $("pos-quick").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-quick]");
    if (btn) setTendered(btn.dataset.quick);
  });
  wireQtyPad();
  $("pos-clear").addEventListener("click", () => {
    cart = [];
    $("pos-tendered").value = "";
    $("pos-gcash-ref").value = "";
    setSaleCustomer(null);
    renderAll();
    $("pos-input").focus({ preventScroll: true });
  });
  $("pos-complete").addEventListener("click", completeSale);
  wireCustomerPicker();

  $("pos-receipt-print").addEventListener("click", () => {
    document.body.classList.add("pos-printing");
    window.print();
  });
  window.addEventListener("afterprint", () => document.body.classList.remove("pos-printing"));
  $("pos-receipt-new").addEventListener("click", newSale);

  window.addEventListener("online", renderPayment);
  window.addEventListener("offline", renderPayment);
  window.addEventListener("beforeunload", (event) => {
    if (cart.length > 0 && !busy) { event.preventDefault(); event.returnValue = ""; }
  });
  // Stock/prices may change from other devices while the page sits open.
  // Only the cart's items are re-read; a full reload happens only after
  // the catalog is several hours old.
  window.addEventListener("focus", async () => {
    if (busy) return;
    const idleMs = Date.now() - lastLoadedAt;
    // Whole catalog costs one read per product, so it is re-downloaded
    // only rarely (e.g. a register left open since the day before).
    if (!indexed && Date.now() - lastFullLoadAt > 3 * 60 * 60000) {
      await loadProducts();
      refreshCartFromProducts();
      renderAll();
    } else if (idleMs > 60000 && cart.length > 0) {
      await refreshCartProducts();
      refreshCartFromProducts();
      renderAll();
    }
  });
}

function allCandidates() {
  return products.flatMap((p) => candidatesForProduct(p));
}

// ----------------------------- SCAN AND LINK --------------------------
// Many imported barcodes are damaged (the spreadsheet turned them into
// numbers like 4.80019E+12). When a real barcode isn't found, the cashier
// searches the product by name and taps Link: the real code is saved to
// that product (or variant) and works on every scan from then on.
function enterLinkMode(code) {
  pendingCode = code;
  $("pos-input").value = "";
  hideMessage();
  renderResults();
}

async function linkBarcodeTo(candidate) {
  const code = pendingCode;
  if (!code || busy) return;
  busy = true;
  try {
    const local = { };
    if (SUPABASE_ENABLED) {
      await SB.linkBarcode(candidate.productId, code, candidate.variantName);
      const current = products.find((p) => p.id === candidate.productId);
      if (candidate.variantName) {
        local.flavors = (current?.flavors || []).map((v) =>
          v && typeof v === "object" && (v.name || v.flavor || v.label || "Variant") === candidate.variantName ? { ...v, barcode: code } : v);
      } else {
        local.barcode = code;
      }
    } else {
      const ref = doc(db, "products", candidate.productId);
      const snap = await getDoc(ref);
      if (!snap.exists()) { showMessage("That product no longer exists.", true); return; }
      const data = snap.data();
      const changes = { barcodes: arrayUnion(code) };
      if (candidate.variantName) {
        const flavors = (Array.isArray(data.flavors) ? data.flavors : []).map((v) =>
          v && typeof v === "object" && (v.name || v.flavor || v.label || "Variant") === candidate.variantName
            ? { ...v, barcode: code }
            : v);
        changes.flavors = flavors;
        local.flavors = flavors;
      } else {
        changes.barcode = code;
        local.barcode = code;
      }
      await updateDoc(ref, changes);
    }
    const index = products.findIndex((p) => p.id === candidate.productId);
    if (index >= 0) {
      const existing = products[index];
      products[index] = { ...existing, ...local, barcodes: [...new Set([...(existing.barcodes || []), code])] };
      seenAt.set(candidate.productId, Date.now());
    }
    pendingCode = null;
    const fresh = allCandidates().find((c) => c.key === candidate.key) || candidate;
    add(fresh);
    showMessage(`Saved. Barcode ${code} now belongs to "${candidate.name}".`, false);
    $("pos-input").value = "";
    renderResults();
  } catch (error) {
    console.error("Couldn't link the barcode:", error);
    showMessage("Couldn't save the barcode. Check the connection and try again.", true);
  } finally {
    busy = false;
  }
}

function add(candidate) {
  applyCartResult(addToCart(cart, candidate, 1));
}

function applyCartResult(result) {
  if (result.error) showMessage(result.error, true); else hideMessage();
  cart = result.cart;
  renderAll();
}

function showMessage(text, isError) {
  const el = $("pos-message");
  el.textContent = text;
  el.hidden = false;
  el.dataset.kind = isError ? "error" : "success";
}
function hideMessage() { $("pos-message").hidden = true; }

// After a fresh product load, bring cart prices/stock limits up to date.
function refreshCartFromProducts() {
  const byKey = new Map(allCandidates().map((c) => [c.key, c]));
  cart = cart
    .map((line) => {
      const fresh = byKey.get(line.key);
      if (!fresh) return null;
      return {
        ...line,
        stock: fresh.stock ?? 0,
        retailUnit: fresh.retailUnit,
        regularUnit: fresh.regularUnit,
        discountPercent: fresh.discountPercent,
        wholesaleUnit: fresh.wholesaleUnit,
        mode: line.mode === "wholesale" && fresh.wholesaleUnit == null ? "retail" : line.mode,
        qty: Math.min(line.qty, Math.max(fresh.stock ?? 0, 0))
      };
    })
    .filter((l) => l && l.qty > 0 && l.retailUnit != null);
}

// ----------------------------- RENDERING ------------------------------
function renderAll() {
  renderResults();
  renderCart();
  renderPayment();
}

function renderResults() {
  const box = $("pos-results");
  const term = $("pos-input").value.trim();
  // Nothing typed: show the whole catalogue (A–Z) so the cashier can tap items
  // instead of leaving this panel empty.
  const browsing = !term;
  const linking = pendingCode != null;
  const linkBanner = linking ? `
    <div class="pos-hint pos-link-banner">
      <strong>Barcode ${esc(pendingCode)} isn't in the system yet.</strong>
      Type the product name below, then tap <b>Link</b> on the right one.
      <button type="button" class="btn-outline" data-link-cancel>Cancel</button>
    </div>` : "";
  // No catalogue list: nothing is shown until the cashier scans or types.
  if (browsing) {
    box.innerHTML = linkBanner || `<p class="notif-list__empty">Scan a barcode or type a product name to find items.</p>`;
    return;
  }
  const rows = (browsing ? products : searchProducts(products, term))
    .flatMap((p) => candidatesForProduct(p));
  if (browsing) rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  if (rows.length === 0) {
    if (browsing) { box.innerHTML = `<p class="notif-list__empty">No products yet.</p>`; return; }
    box.innerHTML = linkBanner + `<p class="notif-list__empty">No products match "${esc(term)}".</p>`;
    return;
  }
  box.innerHTML = linkBanner + (browsing ? `<p class="pos-hint pos-results__label">${indexed ? "Recently found items" : "All products (A–Z)"} — tap Add, or scan / search above</p>` : "") + rows.slice(0, browsing ? 200 : 40).map((c) => `
    <div class="pos-result ${c.inStock ? "" : "is-out"}">
      <div class="pos-result__info">
        <span class="pos-result__name">${esc(c.name)}</span>
        <span class="pos-result__meta">
          ${c.discountPercent ? `<s>${formatMoney(c.regularUnit)}</s> ` : ""}${c.retailUnit != null ? formatMoney(c.retailUnit) : "No price"}
          ${c.wholesaleUnit != null ? ` · Wholesale ${formatMoney(c.wholesaleUnit)}` : ""}
          · ${c.inStock ? `${c.stock} in stock` : "Out of stock"}
        </span>
      </div>
      ${linking
        ? `<button type="button" class="btn-outline" data-link-key="${esc(c.key)}">Link</button>`
        : `<button type="button" class="btn-outline" data-add-key="${esc(c.key)}" ${c.inStock && c.retailUnit != null ? "" : "disabled"}>Add</button>`}
    </div>
  `).join("");
}

function renderCart() {
  const box = $("pos-lines");
  if (cart.length === 0) {
    box.innerHTML = `<p class="notif-list__empty">No items yet. Scan or search to add.</p>`;
  } else {
    box.innerHTML = cart.map((line) => {
      const wholesaleOn = line.mode === "wholesale";
      const canWholesale = line.wholesaleUnit != null;
      return `
        <div class="pos-line">
          <div class="pos-line__top">
            <span class="pos-line__name">${esc(line.name)}</span>
            <button type="button" class="pos-line__remove" data-action="remove" data-key="${esc(line.key)}" aria-label="Remove">✕</button>
          </div>
          <div class="pos-line__row">
            <div class="pos-mode">
              <button type="button" class="pos-mode__btn ${wholesaleOn ? "" : "is-active"}" data-action="mode" data-mode="retail" data-key="${esc(line.key)}">Retail</button>
              <button type="button" class="pos-mode__btn ${wholesaleOn ? "is-active" : ""}" data-action="mode" data-mode="wholesale" data-key="${esc(line.key)}" ${canWholesale ? "" : "disabled title=\"No wholesale price set\""}>Wholesale</button>
            </div>
            <div class="pos-qty">
              <button type="button" data-action="dec" data-key="${esc(line.key)}" aria-label="Less">−</button>
              <input type="number" min="1" max="${line.stock}" value="${line.qty}" inputmode="${IS_TOUCH ? "none" : "numeric"}" data-qty-input="${esc(line.key)}">
              <button type="button" data-action="inc" data-key="${esc(line.key)}" aria-label="More">+</button>
            </div>
            <div class="pos-line__money">
              <span class="pos-line__unit">${formatMoney(lineUnitPrice(line))} each${!wholesaleOn && line.discountPercent ? ` (−${line.discountPercent}%)` : ""}</span>
              <strong>${formatMoney(lineTotal(line))}</strong>
            </div>
          </div>
        </div>`;
    }).join("");
  }
  $("pos-units").textContent = String(cartUnits(cart));
  $("pos-total").textContent = formatMoney(cartTotal(cart));
}

// ----------------------------- NUMBER PAD ------------------------------
const IS_TOUCH = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

// Keeps the cash box to digits with at most 2 decimals (typed or pasted).
function sanitizeAmount(raw) {
  let v = String(raw).replace(/[^\d.]/g, "");
  const dot = v.indexOf(".");
  if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, "").slice(0, 2);
  v = v.replace(/^0+(?=\d)/, "");
  return v.slice(0, 10);
}

function setTendered(value) {
  $("pos-tendered").value = value;
  renderPayment();
}

// Big touch keys: 7 8 9 ⌫ / 4 5 6 C / 1 2 3 . / 0 00  (qty pad: no . or 00).
function buildNumpad(host, { decimal, onKey }) {
  const keys = decimal
    ? [["7"], ["8"], ["9"], ["back", "⌫"], ["4"], ["5"], ["6"], ["clear", "C"], ["1"], ["2"], ["3"], ["."], ["0", "0", 2], ["00", "00", 2]]
    : [["7"], ["8"], ["9"], ["back", "⌫"], ["4"], ["5"], ["6"], ["clear", "C"], ["1"], ["2"], ["3"], ["", "", 1, true], ["0", "0", 4]];
  host.classList.add("pos-pad");
  host.innerHTML = keys.map(([key, label, span, ghost]) => `
    <button type="button" class="pos-pad__key ${key === "back" || key === "clear" ? "pos-pad__key--fn" : ""}"
      ${span ? `style="grid-column: span ${span};"` : ""} ${ghost ? "disabled aria-hidden=\"true\" tabindex=\"-1\" data-ghost=\"1\"" : `data-key="${key}"`}>${label ?? key}</button>`).join("");
  host.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-key]");
    if (btn) onKey(btn.dataset.key);
  });
}

function renderQuickCash(cash) {
  const box = $("pos-quick");
  const total = cartTotal(cart);
  if (!cash || cart.length === 0 || !(total > 0)) { box.innerHTML = ""; return; }
  const exact = Number.isInteger(total) ? String(total) : total.toFixed(2);
  box.innerHTML = [`<button type="button" class="pos-quick__btn pos-quick__btn--exact" data-quick="${exact}">Exact</button>`]
    .concat(quickCashAmounts(total).map((a) => `<button type="button" class="pos-quick__btn" data-quick="${a}">₱${a.toLocaleString("en-PH")}</button>`))
    .join("");
}

// Quantity pad (touch screens): tap a line's quantity to open it.
let qtyPadKey = null;
let qtyEntry = "";

function wireQtyPad() {
  buildNumpad($("pos-qty-pad"), {
    decimal: false,
    onKey: (key) => {
      qtyEntry = applyNumpadKey(qtyEntry, key, { decimal: false, maxInt: 4 });
      renderQtyDisplay();
    }
  });
  $("pos-qty-close").addEventListener("click", closeQtyPad);
  $("pos-qty-cancel").addEventListener("click", closeQtyPad);
  $("pos-qty-ok").addEventListener("click", () => {
    const line = cart.find((l) => l.key === qtyPadKey);
    if (!line) { closeQtyPad(); return; }
    const value = qtyEntry === "" ? line.qty : Number(qtyEntry);
    if (!(value >= 1)) { $("pos-qty-hint").textContent = "Quantity must be at least 1."; return; }
    closeQtyPad();
    applyCartResult(setLineQty(cart, line.key, value));
  });
}

function openQtyPad(key) {
  const line = cart.find((l) => l.key === key);
  if (!line) return;
  qtyPadKey = key;
  qtyEntry = "";
  $("pos-qty-name").textContent = line.name;
  $("pos-qty-hint").textContent = `In stock: ${line.stock}`;
  renderQtyDisplay();
  $("pos-qty-overlay").hidden = false;
}

function renderQtyDisplay() {
  const line = cart.find((l) => l.key === qtyPadKey);
  const el = $("pos-qty-display");
  el.textContent = qtyEntry === "" ? String(line ? line.qty : "") : qtyEntry;
  el.classList.toggle("is-placeholder", qtyEntry === "");
  if (line) $("pos-qty-hint").textContent = `In stock: ${line.stock}`;
}

function closeQtyPad() {
  $("pos-qty-overlay").hidden = true;
  qtyPadKey = null;
}

function paymentState() {
  const total = cartTotal(cart);
  return computePayment(total, method, $("pos-tendered").value);
}

function renderPayment() {
  const cash = method === "cash";
  $("pos-cash-field").hidden = !cash;
  $("pos-gcash-field").hidden = cash;
  $("pos-change-row").hidden = !cash;
  $("pos-pay-pad").hidden = !cash;
  renderQuickCash(cash);

  const pay = paymentState();
  $("pos-change").textContent = formatMoney(pay.ok ? pay.change : 0);
  // Highlight the change box once there is change to give back.
  $("pos-change-row").classList.toggle("has-change", Boolean(pay.ok && pay.change > 0));

  const status = $("pos-pay-status");
  const offline = !navigator.onLine;
  $("pos-offline").hidden = !offline;

  if (cart.length > 0 && cash && !pay.ok && $("pos-tendered").value !== "") {
    status.textContent = pay.error;
    status.hidden = false;
    status.dataset.kind = "error";
  } else {
    status.hidden = true;
  }
  $("pos-complete").disabled = busy || offline || cart.length === 0 || !pay.ok;
}

// ----------------------------- COMPLETING A SALE ----------------------
class SaleError extends Error {}

// If a sale's stock deduction goes out but the answer is lost, the next try
// must reuse the same sale id so the database ignores the repeat.
let lastSaleAttempt = null; // { id, sig }

// Sale against the Supabase product database: check prices, deduct stock in
// one all-or-nothing step, then save the sale record and stock log in Supabase too.
async function commitSaleSupabase(ctx) {
  const { lines, productIds, saleRef, movementRefs, receiptNo, total, units, pay, cashierEmail } = ctx;

  const freshList = await SB.getProductsByIds(productIds);
  const fresh = new Map(freshList.map((p) => [p.id, p]));

  // Prices must still be what the cashier saw.
  for (const line of lines) {
    const data = fresh.get(line.productId);
    if (!data) throw new SaleError(`"${line.name}" no longer exists.`);
    const cand = candidatesForProduct(data).find((c) => c.key === line.key);
    if (!cand) throw new SaleError(`"${line.name}" is no longer available.`);
    const expected = lineUnitPrice(line);
    const actual = line.mode === "wholesale" ? cand.wholesaleUnit : cand.retailUnit;
    if (actual === null || actual === undefined || Math.abs(actual - expected) > 0.001) {
      throw new SaleError(`The price of "${line.name}" changed. Totals were updated — please check and complete again.`);
    }
  }

  const plan = planStockUpdates(fresh, lines);
  if (plan.error) throw new SaleError(plan.error);

  // Deduct stock. A dropped connection is retried with the SAME sale id, so it can never deduct twice.
  let updated = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      updated = await SB.applySale(lines, saleRef.id);
      break;
    } catch (error) {
      const code = error instanceof SB.StoreError ? error.code : "";
      if (/^(insufficient_stock|product_missing|variant_missing|bad_quantity)/.test(code)) {
        lastSaleAttempt = null;
        throw new SaleError(/^insufficient_stock/.test(code)
          ? "Not enough stock for one of the items. Stock was refreshed — please check the cart."
          : "An item in the cart is no longer available.");
      }
      const retryable = code === "network" || /^http_5/.test(code);
      if (!retryable || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  }

  // Use the real stock numbers the database ended with for the stock log.
  plan.movements.forEach((m, i) => {
    const row = updated?.[i];
    if (!row) return;
    let now = null;
    if (m.variantName === null) now = row.stock_count;
    else {
      const v = (row.flavors || []).find((f) => (f.name || f.flavor || f.label) === m.variantName);
      now = v ? v.stock : null;
    }
    if (typeof now === "number") { m.newStock = now; m.previousStock = now + lines[i].qty; }
  });

  const saleData = {
    receiptNo,
    items: buildSaleItems(lines),
    total,
    units,
    paymentMethod: method,
    amountTendered: pay.tendered,
    change: pay.change,
    gcashRef: method === "gcash" ? ($("pos-gcash-ref").value.trim() || null) : null,
    cashierUid: currentUser.uid,
    cashierEmail,
    cashierRole: currentRole,
    ...customerFields(saleCustomer)
  };

  try {
    // Save the sale record, the stock log and today's tally in Supabase. Repeating
    // it with the same sale id changes nothing, so a dropped connection can be retried.
    const payload = { id: saleRef.id, sale: saleData, movements: plan.movements, day: dayKey() };
    let saved = false, lastError = null;
    for (let attempt = 0; attempt < 3 && !saved; attempt++) {
      try { await SB.recordSale(payload); saved = true; }
      catch (error) {
        lastError = error;
        const code = error instanceof SB.StoreError ? error.code : "";
        if (!(code === "network" || /^http_5/.test(code))) break;
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    }
    if (!saved) {
      // The answer may have been lost after the sale was really saved: check before undoing anything.
      let exists = false;
      try { exists = Boolean(await SB.getSale(saleRef.id)); } catch { /* can't tell */ }
      if (!exists) throw lastError;
    }
  } catch (error) {
    // The sale record didn't save, so put the stock back and start fresh next time.
    lastSaleAttempt = null;
    try { await SB.restock(lines); } catch (restockError) { console.error("Couldn't put the stock back:", restockError); }
    throw error;
  }
  return { updates: plan.updates, movements: plan.movements, saleData };
}

async function completeSale() {
  if (busy || cart.length === 0) return;
  const pay = paymentState();
  if (!pay.ok) { showMessage(pay.error, true); return; }
  if (!navigator.onLine) { renderPayment(); return; }

  busy = true;
  const btn = $("pos-complete");
  btn.disabled = true;
  btn.textContent = "Saving...";
  hideMessage();

  const lines = cart.map((l) => ({ ...l }));
  const total = cartTotal(lines);
  const units = cartUnits(lines);
  const receiptNo = makeReceiptNo();
  const sig = JSON.stringify(lines.map((l) => [l.key, l.qty, l.mode]));
  const saleRef = lastSaleAttempt && lastSaleAttempt.sig === sig
    ? doc(db, "posSales", lastSaleAttempt.id)
    : doc(collection(db, "posSales"));
  lastSaleAttempt = { id: saleRef.id, sig };
  const movementRefs = lines.map(() => doc(collection(db, "stockMovements")));
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const cashierEmail = currentUser?.email || "unknown";
  const soldTo = saleCustomer;

  let soldUpdates = null; // what the sale changed, applied on screen afterwards
  let soldMovements = null; // per-product stock changes, used for the daily sales tally
  let savedSale = null;   // the sale record as saved, added to today's list without re-reading it
  try {
    if (SUPABASE_ENABLED) {
      const result = await commitSaleSupabase({ lines, productIds, saleRef, movementRefs, receiptNo, total, units, pay, cashierEmail });
      soldUpdates = result.updates;
      soldMovements = result.movements;
      savedSale = result.saleData;
    } else await runTransaction(db, async (tx) => {
      const fresh = new Map();
      for (const productId of productIds) {
        const snap = await tx.get(doc(db, "products", productId));
        if (snap.exists()) fresh.set(productId, snap.data());
      }

      // Prices must still be what the cashier saw.
      for (const line of lines) {
        const data = fresh.get(line.productId);
        if (!data) throw new SaleError(`"${line.name}" no longer exists.`);
        const cand = candidatesForProduct({ id: line.productId, ...data }).find((c) => c.key === line.key);
        if (!cand) throw new SaleError(`"${line.name}" is no longer available.`);
        const expected = lineUnitPrice(line);
        const actual = line.mode === "wholesale" ? cand.wholesaleUnit : cand.retailUnit;
        if (actual === null || actual === undefined || Math.abs(actual - expected) > 0.001) {
          throw new SaleError(`The price of "${line.name}" changed. Totals were updated — please check and complete again.`);
        }
      }

      const plan = planStockUpdates(fresh, lines);
      if (plan.error) throw new SaleError(plan.error);
      soldUpdates = plan.updates;
      soldMovements = plan.movements;

      for (const [productId, update] of plan.updates) {
        tx.update(doc(db, "products", productId), update);
      }

      const saleData = {
        receiptNo,
        items: buildSaleItems(lines),
        total,
        units,
        paymentMethod: method,
        amountTendered: pay.tendered,
        change: pay.change,
        gcashRef: method === "gcash" ? ($("pos-gcash-ref").value.trim() || null) : null,
        cashierUid: currentUser.uid,
        cashierEmail,
        cashierRole: currentRole,
        ...customerFields(saleCustomer)
      };
      savedSale = saleData;
      tx.set(saleRef, { ...saleData, createdAt: serverTimestamp() });

      plan.movements.forEach((m, i) => {
        tx.set(movementRefs[i], {
          productId: m.productId,
          productName: m.productName,
          variantName: m.variantName,
          type: "sale",
          previousStock: m.previousStock,
          newStock: m.newStock,
          unitPrice: m.unitPrice,
          posSaleId: saleRef.id,
          performedByEmail: cashierEmail,
          performedByRole: currentRole,
          createdAt: serverTimestamp()
        });
      });
    });
  } catch (error) {
    console.error("Sale failed:", error);
    if (error instanceof SaleError) {
      lastSaleAttempt = null;
      await refreshCartProducts();
      refreshCartFromProducts();
      renderAll();
      showMessage(error.message, true);
    } else {
      showMessage("Couldn't save the sale. Nothing was charged or deducted — check the connection and try again.", true);
    }
    busy = false;
    btn.textContent = "Complete sale";
    renderPayment();
    return;
  }

  lastSaleAttempt = null;
  applyLocalUpdates(soldUpdates);
  recordSaleTally(soldMovements); // after the sale is saved; never blocks it
  busy = false;
  btn.textContent = "Complete sale";
  addSaleToHistory({ id: saleRef.id, ...savedSale, createdAt: Timestamp.now() });
  showReceipt({
    receiptNo, lines, total, units,
    paymentMethod: method, tendered: pay.tendered, change: pay.change,
    gcashRef: method === "gcash" ? $("pos-gcash-ref").value.trim() : "",
    cashierEmail, when: new Date(),
    customerName: soldTo?.name || ""
  });
}


// ----------------------------- CUSTOMER (optional) --------------------
// The cashier can attach the sale to a registered customer (same account
// they use for online orders) or just type a name for a regular who isn't
// registered. This is what lets the admin's "Top Customers" list count a
// person's online and in-store purchases together. Leaving it empty is
// normal: the sale is simply anonymous, as before.
function customerFields(customer) {
  if (!customer) return {};
  return {
    customerType: customer.type,
    customerName: customer.name,
    customerId: customer.uid || null,
    customerMobile: customer.mobile || null
  };
}

function setSaleCustomer(customer) {
  saleCustomer = customer;
  const picked = $("pos-customer-picked");
  const input = $("pos-customer-input");
  if (!picked || !input) return;
  picked.hidden = !customer;
  input.hidden = Boolean(customer);
  input.value = "";
  $("pos-customer-results").hidden = true;
  if (customer) {
    $("pos-customer-name").textContent = customer.type === "registered"
      ? `${customer.name}${customer.mobile ? " · " + customer.mobile : ""}`
      : `${customer.name} (walk-in)`;
  }
}

// Finds registered customers by asking the database for names or mobile
// numbers that START with what was typed (a few reads per search), instead
// of downloading every customer.
const customerSearchCache = new Map(); // typed text -> { at, list }
const CUSTOMER_LIMIT = 8;

function nameVariants(text) {
  const t = text.trim();
  const title = t.toLowerCase().replace(/(^|[\s\-.'])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
  const first = t.charAt(0).toUpperCase() + t.slice(1);
  return [...new Set([t, title, first, t.toUpperCase(), t.toLowerCase()])];
}

async function prefixQuery(field, prefix) {
  const snap = await getDocs(query(
    collection(db, "users"),
    where(field, ">=", prefix),
    where(field, "<=", prefix + "\uf8ff"),
    limit(CUSTOMER_LIMIT)
  ));
  return snap.docs.map((d) => {
    const data = d.data();
    return {
      uid: d.id,
      name: String(data.fullName || data.name || "").trim(),
      mobile: String(data.mobileNumber || data.phone || "").trim()
    };
  });
}

async function searchCustomers(text) {
  const key = text.toLowerCase();
  const cached = customerSearchCache.get(key);
  if (cached && Date.now() - cached.at < 60000) return cached.list;

  const jobs = [];
  const digits = text.replace(/[\s\-()]/g, "");
  if (/^\+?\d{3,}$/.test(digits)) {
    jobs.push(prefixQuery("mobileNumber", digits));
    if (digits.startsWith("0")) jobs.push(prefixQuery("mobileNumber", "+63" + digits.slice(1)));
  } else if (text.length >= 2) {
    nameVariants(text).forEach((v) => jobs.push(prefixQuery("fullName", v)));
  }
  let list = [];
  try {
    const settled = await Promise.all(jobs);
    const seen = new Map();
    settled.flat().forEach((c) => { if (c.name && !seen.has(c.uid)) seen.set(c.uid, c); });
    list = [...seen.values()];
  } catch (error) {
    console.error("Couldn't search customers:", error);
    return [];
  }
  customerSearchCache.set(key, { at: Date.now(), list });
  return list;
}

function wireCustomerPicker() {
  const input = $("pos-customer-input");
  const results = $("pos-customer-results");
  if (!input) return;
  let customerTimer = null;

  async function showMatches() {
    const text = input.value.trim();
    if (!text) { results.hidden = true; return; }
    const matches = (await searchCustomers(text)).slice(0, 6);
    if (input.value.trim() !== text) return; // typed more while searching

    results.innerHTML = "";
    matches.forEach((c) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pos-customer__option";
      btn.textContent = c.mobile ? `${c.name} · ${c.mobile}` : c.name;
      btn.addEventListener("click", () => setSaleCustomer({ type: "registered", uid: c.uid, name: c.name, mobile: c.mobile }));
      results.appendChild(btn);
    });
    if (!/^\d+$/.test(text)) {
      const walk = document.createElement("button");
      walk.type = "button";
      walk.className = "pos-customer__option pos-customer__option--walkin";
      walk.textContent = `Use "${text}" as a walk-in customer`;
      walk.addEventListener("click", () => setSaleCustomer({ type: "walkin", name: text.slice(0, 60) }));
      results.appendChild(walk);
    }
    results.hidden = results.children.length === 0;
  }

  // Wait for a pause in typing so each keystroke doesn't run a search.
  input.addEventListener("input", () => {
    clearTimeout(customerTimer);
    customerTimer = setTimeout(showMatches, 300);
  });
  $("pos-customer-clear").addEventListener("click", () => setSaleCustomer(null));
}

// ----------------------------- RECEIPT --------------------------------
function showReceipt(sale) {
  const rows = sale.lines.map((l) => `
    <tr>
      <td>${esc(l.name)}${l.mode === "wholesale" ? " <em>(wholesale)</em>" : ""}<br><small>${l.qty} × ${formatMoney(lineUnitPrice(l))}</small></td>
      <td class="r">${formatMoney(lineTotal(l))}</td>
    </tr>`).join("");

  $("pos-receipt").innerHTML = `
    <div class="pos-receipt__head">
      <strong>${STORE_NAME}</strong>
      <span>${esc(sale.receiptNo)}</span>
      <span>${esc(sale.when.toLocaleString())}</span>
      <span>Cashier: ${esc(sale.cashierEmail)}</span>
      ${sale.customerName ? `<span>Customer: ${esc(sale.customerName)}</span>` : ""}
    </div>
    <table>${rows}</table>
    <div class="pos-receipt__sum">
      <div><span>Items</span><span>${sale.units}</span></div>
      <div class="pos-receipt__total"><span>Total</span><span>${formatMoney(sale.total)}</span></div>
      <div><span>Paid by</span><span>${sale.paymentMethod === "gcash" ? "GCash" : "Cash"}</span></div>
      ${sale.paymentMethod === "cash"
        ? `<div><span>Cash received</span><span>${formatMoney(sale.tendered)}</span></div><div><span>Change</span><span>${formatMoney(sale.change)}</span></div>`
        : (sale.gcashRef ? `<div><span>GCash ref</span><span>${esc(sale.gcashRef)}</span></div>` : "")}
    </div>
    <p class="pos-receipt__thanks">Thank you for shopping at ${STORE_NAME}!</p>`;
  $("pos-receipt-overlay").hidden = false;
}

async function newSale() {
  $("pos-receipt-overlay").hidden = true;
  cart = [];
  $("pos-tendered").value = "";
  $("pos-gcash-ref").value = "";
  setSaleCustomer(null);
  $("pos-input").value = "";
  renderAll();               // stock was already updated on screen after the sale
  $("pos-input").focus({ preventScroll: true });
}


// ====================================================================
// RECENT SALES + REFUND / VOID
// ----------------------------------------------------------------
// A refund never edits the original sale's items or total. It records
// how much of each line has been refunded on the sale (refundedQtys /
// refundedTotal), writes a posRefunds entry (who, why, how much), and —
// unless "return to stock" is unticked — puts the units back and logs
// them in the stock log as "return". Everything happens in one
// transaction, so the same item can't be refunded twice by two devices.
// ====================================================================
let historySales = [];
let refundSale = null;
let refundQtys = [];
class RefundError extends Error {}

function pad2(n) { return String(n).padStart(2, "0"); }
function dateInputValue(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

function wireHistory() {
  const dateInput = $("pos-history-date");
  dateInput.value = dateInputValue(new Date());
  dateInput.addEventListener("change", loadHistory);
  $("pos-history-search").addEventListener("input", renderHistory);

  $("pos-history-body").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-refund-sale]");
    if (!btn) return;
    const sale = historySales.find((x) => x.id === btn.dataset.refundSale);
    if (sale) openRefund(sale);
  });

  $("pos-refund-close").addEventListener("click", closeRefund);
  $("pos-refund-cancel").addEventListener("click", closeRefund);
  $("pos-refund-all").addEventListener("click", () => {
    refundQtys = refundSale.items.map((_, i) => remainingQty(refundSale, i));
    renderRefund();
  });
  $("pos-refund-items").addEventListener("input", (event) => {
    const el = event.target.closest("[data-refund-index]");
    if (!el) return;
    const i = Number(el.dataset.refundIndex);
    const max = remainingQty(refundSale, i);
    let v = Math.floor(Number(el.value));
    if (!Number.isFinite(v) || v < 0) v = 0;
    refundQtys[i] = Math.min(v, max);
    updateRefundSummary();
  });
  $("pos-refund-items").addEventListener("change", (event) => {
    const el = event.target.closest("[data-refund-index]");
    if (el) el.value = refundQtys[Number(el.dataset.refundIndex)];
  });
  // Right after a scan the cursor must stay in the scan box, never jump to the Customer box.
  $("pos-customer-input").addEventListener("focus", () => {
    if (Date.now() - lastScanAt < 800) $("pos-input").focus({ preventScroll: true });
  });
  const reasonSelect = $("pos-refund-reason-select");
  reasonSelect.replaceChildren(...[...REFUND_REASONS, "Others (please specify)"].map((r, i, all) => {
    const o = document.createElement("option");
    o.value = i === all.length - 1 ? "__other__" : r;
    o.textContent = r;
    return o;
  }));
  reasonSelect.addEventListener("change", () => {
    $("pos-refund-reason").hidden = reasonSelect.value !== "__other__";
    if (!$("pos-refund-reason").hidden) $("pos-refund-reason").focus();
    updateRefundSummary();
  });
  $("pos-refund-reason").addEventListener("input", updateRefundSummary);
  $("pos-refund-confirm").addEventListener("click", confirmRefund);
}

// Adds a just-completed sale to today's list on screen. Re-reading the whole
// day after every sale would cost more reads with each sale made.
function addSaleToHistory(sale) {
  if ($("pos-history-date").value !== dateInputValue(new Date())) return; // another day is shown
  if (historySales.some((x) => x.id === sale.id)) return;
  historySales.unshift(sale);
  renderHistory();
}

async function loadHistory() {
  const body = $("pos-history-body");
  body.innerHTML = `<tr><td colspan="7" class="inventory-empty">Loading...</td></tr>`;
  try {
    const [y, m, d] = $("pos-history-date").value.split("-").map(Number);
    const start = new Date(y, m - 1, d, 0, 0, 0, 0);
    const end = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
    if (SUPABASE_ENABLED) {
      historySales = await SB.listSales(start, end);
      renderHistory();
      return;
    }
    const snap = await getDocs(query(
      collection(db, "posSales"),
      where("createdAt", ">=", Timestamp.fromDate(start)),
      where("createdAt", "<", Timestamp.fromDate(end)),
      orderBy("createdAt", "desc")
    ));
    historySales = snap.docs.map((x) => ({ id: x.id, ...x.data() }));
    renderHistory();
  } catch (error) {
    console.error("Couldn't load recent sales:", error);
    body.innerHTML = `<tr><td colspan="7" class="inventory-empty">Couldn't load recent sales.</td></tr>`;
  }
}

function renderHistory() {
  const body = $("pos-history-body");
  const term = $("pos-history-search").value.trim().toLowerCase();
  const rows = historySales.filter((x) => !term || String(x.receiptNo || "").toLowerCase().includes(term));
  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="7" class="inventory-empty">${historySales.length ? "No receipt matches." : "No sales on this day."}</td></tr>`;
    return;
  }
  body.innerHTML = rows.map((x) => {
    const status = saleRefundStatus(x);
    const time = x.createdAt?.toDate ? x.createdAt.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
    const badge = status === "full"
      ? `<span class="order-badge order-badge--cancelled">Voided / refunded</span>`
      : status === "partial"
        ? `<span class="order-badge order-badge--pending">Partial refund −${formatMoney(x.refundedTotal || 0)}</span>`
        : `<span class="order-badge order-badge--delivered">Paid</span>`;
    return `
      <tr>
        <td>${esc(time)}</td>
        <td>${esc(x.receiptNo || x.id)}</td>
        <td>${x.units ?? (x.items || []).length}</td>
        <td>${x.paymentMethod === "gcash" ? "GCash" : "Cash"}</td>
        <td style="text-align:right;">${formatMoney(x.total)}</td>
        <td>${badge}</td>
        <td style="text-align:right;">${status === "full" ? "" : `<button type="button" class="btn-outline" data-refund-sale="${esc(x.id)}">Refund / Void</button>`}</td>
      </tr>`;
  }).join("");
}

const REFUND_REASONS = [
  "Wrong item rung up",
  "Customer returned the item",
  "Item damaged or defective",
  "Item expired",
  "Wrong price",
  "Customer changed their mind",
  "Duplicate or mistaken sale"
];

// The chosen reason: a ready-made one, or what was typed under "Others".
function refundReasonText() {
  const sel = $("pos-refund-reason-select");
  return sel.value === "__other__" ? $("pos-refund-reason").value.trim() : sel.value;
}

function openRefund(sale) {
  refundSale = sale;
  refundQtys = sale.items.map(() => 0);
  $("pos-refund-title").textContent = `Refund / Void — ${sale.receiptNo || ""}`;
  $("pos-refund-reason-select").selectedIndex = 0;
  $("pos-refund-reason").value = "";
  $("pos-refund-reason").hidden = true;
  $("pos-refund-restock").checked = false;
  $("pos-refund-status").hidden = true;
  renderRefund();
  $("pos-refund-overlay").hidden = false;
}

function closeRefund() {
  $("pos-refund-overlay").hidden = true;
  refundSale = null;
}

function renderRefund() {
  $("pos-refund-items").innerHTML = refundSale.items.map((item, i) => {
    const left = remainingQty(refundSale, i);
    const done = itemRefundedQty(refundSale, i);
    const name = item.variantName ? `${item.productName} — ${item.variantName}` : item.productName;
    return `
      <div class="pos-refund-row">
        <div class="pos-refund-row__info">
          <strong>${esc(name)}</strong>
          <small>${item.qty} × ${formatMoney(item.unitPrice)}${item.priceMode === "wholesale" ? " (wholesale)" : ""}${done ? ` · ${done} already refunded` : ""}</small>
        </div>
        <input type="number" min="0" max="${left}" value="${refundQtys[i]}" inputmode="numeric" data-refund-index="${i}" ${left === 0 ? "disabled" : ""} aria-label="Quantity to refund">
        <span class="pos-refund-row__of">of ${left}</span>
      </div>`;
  }).join("");
  updateRefundSummary();
}

function updateRefundSummary() {
  const total = refundSale.items.reduce((sum, item, i) => sum + round2((item.unitPrice || 0) * (refundQtys[i] || 0)), 0);
  $("pos-refund-total").textContent = formatMoney(round2(total));
  const reasonOk = refundReasonText().length > 0;
  $("pos-refund-confirm").disabled = busy || total <= 0 || !reasonOk || !navigator.onLine;
}

function setRefundStatus(text, kind) {
  const el = $("pos-refund-status");
  el.textContent = text;
  el.dataset.kind = kind;
  el.hidden = false;
}

// Refund / void against the Supabase sales records.
async function confirmRefundSupabase() {
  const reason = refundReasonText();
  if (!reason) return;
  const restock = $("pos-refund-restock").checked;
  const requested = [...refundQtys];
  const saleId = refundSale.id;
  const cashierEmail = currentUser?.email || "unknown";

  busy = true;
  const btn = $("pos-refund-confirm");
  btn.disabled = true;
  btn.textContent = "Saving...";
  const reset = () => { busy = false; btn.textContent = "Confirm refund"; updateRefundSummary(); };

  let outcome;
  try {
    const sale = await SB.getSale(saleId);
    if (!sale) throw new RefundError("That sale no longer exists.");
    const plan = planRefund(sale, requested);
    if (plan.error) throw new RefundError(plan.error);

    let stock = { updates: new Map(), movements: [], skipped: [] };
    if (restock) {
      const list = await SB.getProductsByIds([...new Set(plan.lines.map((l) => l.productId))]);
      stock = planRestock(new Map(list.map((p) => [p.id, p])), plan.lines);
    }
    const wasUntouched = saleRefundStatus(sale) === "none";
    const refundId = SB.newProductId();

    await SB.recordRefund({
      saleId,
      expected: sale.refundedQtys ?? null,
      update: { refundedQtys: plan.refundedQtys, refundedTotal: plan.refundedTotal, refundStatus: plan.status },
      refundId,
      refund: {
        saleId,
        receiptNo: sale.receiptNo || null,
        kind: wasUntouched && plan.status === "full" ? "void" : "refund",
        items: plan.lines,
        total: plan.total,
        reason,
        restocked: restock,
        notRestocked: stock.skipped,
        paymentMethod: sale.paymentMethod || null,
        cashierEmail,
        cashierRole: currentRole
      },
      movements: stock.movements,
    });
    outcome = {
      total: plan.total, skipped: stock.skipped, receiptNo: sale.receiptNo, updates: stock.updates, lines: plan.lines,
      refundedQtys: plan.refundedQtys, refundedTotal: plan.refundedTotal, refundStatus: plan.status
    };
  } catch (error) {
    console.error("Refund failed:", error);
    reset();
    if (error instanceof RefundError) {
      setRefundStatus(error.message, "error");
      loadHistory();
    } else if (error instanceof SB.StoreError && error.code === "sale_changed") {
      setRefundStatus("This sale was changed on another device. Please try again.", "error");
      loadHistory();
    } else {
      setRefundStatus("Couldn't save the refund. Nothing was changed — check the connection and try again.", "error");
    }
    return;
  }

  // The refund is saved. Now return the stock.
  let stockWarning = "";
  if (restock) {
    const label = (l) => (l.variantName ? `${l.productName} — ${l.variantName}` : l.productName);
    const toReturn = outcome.lines.filter((l) => !outcome.skipped.includes(label(l)));
    if (toReturn.length) {
      try { await SB.restock(toReturn); }
      catch (error) {
        console.error("Couldn't return the stock:", error);
        stockWarning = " The stock could NOT be added back automatically — please add it back in Inventory.";
      }
    }
  }

  busy = false;
  btn.textContent = "Confirm refund";
  closeRefund();
  const method = historySales.find((x) => x.id === saleId)?.paymentMethod === "gcash" ? "GCash" : "cash";
  let msg = `Refunded ${formatMoney(outcome.total)} (${method}) for ${outcome.receiptNo || "the sale"}.`;
  if (outcome.skipped.length) msg += ` Not returned to stock (item no longer exists): ${outcome.skipped.join(", ")}.`;
  showMessage(msg + stockWarning, !!stockWarning);
  applyLocalUpdates(outcome.updates);
  refreshCartFromProducts();
  renderAll();
  const refundedSale = historySales.find((x) => x.id === saleId);
  if (refundedSale) {
    refundedSale.refundedQtys = outcome.refundedQtys;
    refundedSale.refundedTotal = outcome.refundedTotal;
    refundedSale.refundStatus = outcome.refundStatus;
    renderHistory();
  } else {
    loadHistory();
  }
}

async function confirmRefund() {
  if (busy || !refundSale) return;
  if (SUPABASE_ENABLED) return confirmRefundSupabase();
  const reason = refundReasonText();
  if (!reason) return;
  const restock = $("pos-refund-restock").checked;
  const requested = [...refundQtys];
  const saleId = refundSale.id;
  const saleRef = doc(db, "posSales", saleId);
  const refundRef = doc(collection(db, "posRefunds"));
  const cashierEmail = currentUser?.email || "unknown";

  busy = true;
  const btn = $("pos-refund-confirm");
  btn.disabled = true;
  btn.textContent = "Saving...";
  let outcome = null;

  // With Supabase the product stock is read ahead of the Firebase transaction.
  let prefetch = null;
  if (SUPABASE_ENABLED && restock) {
    try {
      const first = await getDoc(saleRef);
      if (first.exists()) {
        const plan0 = planRefund({ id: saleId, ...first.data() }, requested);
        if (!plan0.error) {
          const list = await SB.getProductsByIds([...new Set(plan0.lines.map((l) => l.productId))]);
          prefetch = {
            linesKey: JSON.stringify(plan0.lines),
            stock: planRestock(new Map(list.map((p) => [p.id, p])), plan0.lines)
          };
        }
      }
    } catch (error) {
      console.error("Couldn't read the products for the refund:", error);
      busy = false;
      btn.textContent = "Confirm refund";
      setRefundStatus("Couldn't reach the product database. Nothing was changed — check the connection and try again.", "error");
      updateRefundSummary();
      return;
    }
  }

  try {
    outcome = await runTransaction(db, async (tx) => {
      const saleSnap = await tx.get(saleRef);
      if (!saleSnap.exists()) throw new RefundError("That sale no longer exists.");
      const sale = { id: saleId, ...saleSnap.data() };

      const plan = planRefund(sale, requested);
      if (plan.error) throw new RefundError(plan.error);

      let stock;
      if (SUPABASE_ENABLED) {
        if (restock) {
          if (!prefetch || prefetch.linesKey !== JSON.stringify(plan.lines)) {
            throw new RefundError("This sale changed while refunding. Please try again.");
          }
          stock = prefetch.stock;
        } else {
          stock = { updates: new Map(), movements: [], skipped: [] };
        }
      } else {
        const fresh = new Map();
        if (restock) {
          for (const productId of [...new Set(plan.lines.map((l) => l.productId))]) {
            const snap = await tx.get(doc(db, "products", productId));
            if (snap.exists()) fresh.set(productId, snap.data());
          }
        }
        stock = restock ? planRestock(fresh, plan.lines) : { updates: new Map(), movements: [], skipped: [] };
      }
      const wasUntouched = saleRefundStatus(sale) === "none";

      tx.update(saleRef, {
        refundedQtys: plan.refundedQtys,
        refundedTotal: plan.refundedTotal,
        refundStatus: plan.status
      });

      tx.set(refundRef, {
        saleId,
        receiptNo: sale.receiptNo || null,
        kind: wasUntouched && plan.status === "full" ? "void" : "refund",
        items: plan.lines,
        total: plan.total,
        reason,
        restocked: restock,
        notRestocked: stock.skipped,
        paymentMethod: sale.paymentMethod || null,
        cashierUid: currentUser.uid,
        cashierEmail,
        cashierRole: currentRole,
        createdAt: serverTimestamp()
      });

      if (!SUPABASE_ENABLED) {
        for (const [productId, update] of stock.updates) {
          tx.update(doc(db, "products", productId), update);
        }
      }
      stock.movements.forEach((m) => {
        tx.set(doc(collection(db, "stockMovements")), {
          productId: m.productId,
          productName: m.productName,
          variantName: m.variantName,
          type: "return",
          previousStock: m.previousStock,
          newStock: m.newStock,
          unitPrice: m.unitPrice,
          posSaleId: saleId,
          posRefundId: refundRef.id,
          performedByEmail: cashierEmail,
          performedByRole: currentRole,
          createdAt: serverTimestamp()
        });
      });

      return {
        total: plan.total, skipped: stock.skipped, receiptNo: sale.receiptNo, updates: stock.updates, lines: plan.lines,
        refundedQtys: plan.refundedQtys, refundedTotal: plan.refundedTotal, refundStatus: plan.status
      };
    });
  } catch (error) {
    console.error("Refund failed:", error);
    busy = false;
    btn.textContent = "Confirm refund";
    if (error instanceof RefundError) {
      setRefundStatus(error.message, "error");
      loadHistory();
    } else {
      setRefundStatus("Couldn't save the refund. Nothing was changed — check the connection and try again.", "error");
    }
    updateRefundSummary();
    return;
  }

  // The refund is saved. Now return the stock in the Supabase product database.
  let stockWarning = "";
  if (SUPABASE_ENABLED && restock) {
    const label = (l) => (l.variantName ? `${l.productName} — ${l.variantName}` : l.productName);
    const toReturn = outcome.lines.filter((l) => !outcome.skipped.includes(label(l)));
    if (toReturn.length) {
      try { await SB.restock(toReturn); }
      catch (error) {
        console.error("Couldn't return the stock:", error);
        stockWarning = " The stock could NOT be added back automatically — please add it back in Inventory.";
      }
    }
  }

  busy = false;
  btn.textContent = "Confirm refund";
  closeRefund();
  const method = historySales.find((x) => x.id === saleId)?.paymentMethod === "gcash" ? "GCash" : "cash";
  let msg = `Refunded ${formatMoney(outcome.total)} (${method}) for ${outcome.receiptNo || "the sale"}.`;
  if (outcome.skipped.length) msg += ` Not returned to stock (item no longer exists): ${outcome.skipped.join(", ")}.`;
  showMessage(msg + stockWarning, !!stockWarning);
  applyLocalUpdates(outcome.updates);
  refreshCartFromProducts();
  renderAll();
  const refundedSale = historySales.find((x) => x.id === saleId);
  if (refundedSale) {
    refundedSale.refundedQtys = outcome.refundedQtys;
    refundedSale.refundedTotal = outcome.refundedTotal;
    refundedSale.refundStatus = outcome.refundStatus;
    renderHistory();
  } else {
    loadHistory();
  }
}
