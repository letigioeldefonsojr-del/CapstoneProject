// pos — Counter POS page: cart, checkout, receipts, refunds.

import { db } from "./firebase-config.js";
import {
  collection, doc, getDoc, runTransaction, serverTimestamp, getDocs, query, where, orderBy, limit, Timestamp, updateDoc, arrayUnion, writeBatch
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getProducts, primeProductsCache } from "./ProductCache.js?v=3";
import { queryToken } from "./ProductIndex.js";
import { recordSaleTally, dayKey } from "./SalesDaily.js?v=20261029b";
import { SUPABASE_ENABLED } from "./SupabaseConfig.js";
import * as SB from "./SupabaseStore.js?v=20261116b";
import {
  candidatesForProduct, findCandidateByBarcode, searchProducts,
  addToCart, addUnitToCart, addPricedToCart, setLinePrices, setUnitLinePrice, stockQty, setLineQty, setLineMode, removeLine,
  lineUnitPrice, lineTotal, linePricing, cartTotal, cartUnits, cartRegularSubtotal, cartWholesaleDiscount, WHOLESALE_GROUP_SIZE, wsSize,
  computePayment, planStockUpdates, makeReceiptNo, buildSaleItems, formatMoney,
  itemRefundedQty, remainingQty, saleRefundStatus, planRefund, planRestock, round2,
  applyNumpadKey, quickCashAmounts
} from "./CashierLogic.js?v=20261117b";

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

let cashierName = "";
async function loadCashierName() {
  const user = currentUser;
  if (!user) return;
  const key = `almares_cashier_name_${user.uid}`;
  try {
    const cached = sessionStorage.getItem(key);
    if (cached) { cashierName = cached; return; }
  } catch (e) { /* storage unavailable: just read it */ }
  let name = "";
  if (currentRole === "employee") {
    try {
      const snap = await getDoc(doc(db, "employees", user.uid));
      if (snap.exists()) {
        const d = snap.data();
        name = [d.firstName, d.lastName].filter(Boolean).join(" ").trim() || String(d.fullName || d.name || "").trim();
      }
    } catch (error) { console.error("Couldn't load the cashier's name:", error); }
  }
  if (!name) name = user.displayName || "";
  cashierName = name;
  if (name) { try { sessionStorage.setItem(key, name); } catch (e) { /* fine */ } }
}
function cashierLabel() {
  return cashierName || currentUser?.displayName || currentUser?.email || "unknown";
}

document.addEventListener("sidebar:ready", async (event) => {
  currentUser = event.detail.user;
  currentRole = event.detail.role || "employee";
  loadCashierName(); // in the background; a sale uses the email until it arrives
  wireUi();
  wireHistory();
  await initCatalog();
  renderAll();
  loadHistory();
  focusScanInput();
});

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

function applyLocalUpdates(updates) {
  if (!updates) return;
  for (const [productId, update] of updates) {
    const product = products.find((p) => p.id === productId);
    if (product) Object.assign(product, update);
  }
  saveProductsCopy();
}

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
  wireUnitPrompt();
  wireEditDialog();
  wireStages();

  input.addEventListener("input", () => {
    const value = input.value.trim();
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
    if (el.dataset.action === "edit") { openEditDialog(line); return; }
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

  $("pos-tendered").addEventListener("input", () => {
    setTendered(sanitizeAmount(getTendered()));
  });
  buildNumpad($("pos-pay-pad"), {
    decimal: true,
    onKey: (key) => setTendered(applyNumpadKey(getTendered(), key))
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
  window.addEventListener("focus", async () => {
    if (busy) return;
    const idleMs = Date.now() - lastLoadedAt;
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
  if (!askUnitEnabled() || !candidate.inStock || candidate.retailUnit == null) {
    applyCartResult(addToCart(cart, candidate, 1));
    return;
  }
  openUnitPrompt(candidate);
}

// ---------------- "How is this sold?" prompt: piece, pack, ream, 1/2 case, case or other ----------------
const UNIT_MEMORY_KEY = "almares_pos_units_v1";
const UNIT_OPTIONS = [
  { id: "piece", label: "Piece" }, { id: "pack", label: "Pack" }, { id: "ream", label: "Ream" },
  { id: "half", label: "1/2 case" }, { id: "case", label: "Case" }, { id: "other", label: "Other" }
];
let unitPrompt = null;

function askUnitEnabled() {
  try { return localStorage.getItem("almares_pos_ask_unit") !== "0"; } catch { return true; }
}
function readUnitMemory() {
  try { return JSON.parse(localStorage.getItem(UNIT_MEMORY_KEY) || "{}"); } catch { return {}; }
}
function writeUnitMemory(memory) {
  try { localStorage.setItem(UNIT_MEMORY_KEY, JSON.stringify(memory)); } catch { /* optional */ }
}

function openUnitPrompt(candidate) {
  const memory = readUnitMemory()[candidate.key] || {};
  unitPrompt = { candidate, unitId: memory.last && UNIT_OPTIONS.some((o) => o.id === memory.last) ? memory.last : "piece", memory };
  $("pos-unit-name").textContent = candidate.name;
  $("pos-unit-overlay").hidden = false;
  renderUnitPrompt();
}

function closeUnitPrompt() {
  $("pos-unit-overlay").hidden = true;
  unitPrompt = null;
  focusScanInput();
}

function unitDefaults(unitId) {
  const { candidate, memory } = unitPrompt;
  const saved = memory[unitId] || {};
  let pieces = saved.pieces || "";
  if (unitId === "half" && !pieces && memory.case?.pieces) pieces = Math.max(1, Math.floor(memory.case.pieces / 2));
  const price = saved.price || (pieces && candidate.retailUnit != null ? round2(pieces * candidate.retailUnit) : "");
  return { pieces, price };
}

function renderUnitPrompt() {
  const { candidate, unitId } = unitPrompt;
  const opt = UNIT_OPTIONS.find((o) => o.id === unitId);
  const isPiece = unitId === "piece";
  const d = unitDefaults(unitId);
  $("pos-unit-options").innerHTML = UNIT_OPTIONS.map((o) =>
    `<button type="button" class="pos-unit-opt ${o.id === unitId ? "is-on" : ""}" data-unit="${o.id}">${o.label}</button>`).join("");
  const customLabel = unitId === "other"
    ? `<label class="pos-unit-field"><span>What do you call it? (e.g. box, bundle, sack)</span><input type="text" id="pos-unit-label" maxlength="20" placeholder="Unit name"></label>` : "";
  $("pos-unit-fields").innerHTML = isPiece ? `
      <label class="pos-unit-field"><span>Quantity (pieces)</span><input type="number" id="pos-unit-count" min="1" value="1" inputmode="numeric"></label>
      <div class="pos-unit-pair">
        <label class="pos-unit-field"><span>Retail price (₱) each</span><input type="number" id="pos-unit-retail" min="0" step="0.01" value="${candidate.retailUnit ?? ""}" inputmode="decimal"></label>
        <label class="pos-unit-field"><span>Wholesale price (₱) each</span><input type="number" id="pos-unit-ws" min="0" step="0.01" value="${candidate.wholesaleUnit ?? ""}" placeholder="None" inputmode="decimal"></label>
      </div>
      <label class="pos-unit-field"><span>Wholesale price starts at (pieces per set)</span><input type="number" id="pos-unit-wssize" min="2" step="1" value="${WHOLESALE_GROUP_SIZE}" inputmode="numeric"></label>
      <p class="pos-hint">${candidate.wholesaleUnit != null ? "Wholesale applies to every full set of pieces." : "No wholesale price yet. Type one to price every full set, or leave it empty."} These changes are for this sale only.</p>`
    : `${customLabel}
      <label class="pos-unit-field"><span>Pieces in one <b class="pos-unit-name-label">${esc(opt.label.toLowerCase())}</b></span><input type="number" id="pos-unit-pieces" min="1" value="${d.pieces}" inputmode="numeric"></label>
      <label class="pos-unit-field"><span>Price per <b class="pos-unit-name-label">${esc(opt.label.toLowerCase())}</b> (₱) — you can change this</span><input type="number" id="pos-unit-price" min="0" step="0.01" value="${d.price}" inputmode="decimal"></label>
      <label class="pos-unit-field"><span>How many <b class="pos-unit-name-label">${esc(opt.label.toLowerCase())}</b></span><input type="number" id="pos-unit-count" min="1" value="1" inputmode="numeric"></label>`;
  updateUnitSummary();
  const first = $("pos-unit-fields").querySelector("input");
  if (first) { first.focus(); first.select?.(); }
}

function readUnitInputs() {
  const { unitId } = unitPrompt;
  const opt = UNIT_OPTIONS.find((o) => o.id === unitId);
  const label = unitId === "other" ? (($("pos-unit-label")?.value || "").trim() || "unit") : opt.label.toLowerCase();
  return {
    label,
    pieces: Number($("pos-unit-pieces")?.value),
    price: Number($("pos-unit-price")?.value),
    count: Number($("pos-unit-count")?.value)
  };
}

function updateUnitSummary() {
  if (!unitPrompt) return;
  const { candidate, unitId } = unitPrompt;
  const el = $("pos-unit-summary");
  const v = readUnitInputs();
  if (unitId === "piece") {
    el.textContent = Number.isFinite(v.count) && v.count >= 1 ? `${v.count} piece${v.count === 1 ? "" : "s"} at the prices above.` : "";
    return;
  }
  document.querySelectorAll(".pos-unit-name-label").forEach((n) => { n.textContent = v.label; });
  if (!(v.pieces >= 1) || !(v.price > 0) || !(v.count >= 1)) { el.textContent = "Fill in the pieces, the price and how many."; return; }
  const totalPieces = v.pieces * v.count;
  const total = round2(v.price * v.count);
  const normal = round2(totalPieces * (candidate.retailUnit ?? 0));
  const over = candidate.stock !== null && totalPieces > candidate.stock;
  el.innerHTML = `${v.count} ${esc(v.label)} × ${v.pieces} pcs = <b>${totalPieces} pcs</b> out of stock · Total <b>${formatMoney(total)}</b>`
    + `<br><small>Piece price for ${totalPieces} pcs would be ${formatMoney(normal)} (${total < normal ? "you save the customer " + formatMoney(normal - total) : total > normal ? "set " + formatMoney(total - normal) + " higher" : "same"}).</small>`
    + (over ? `<br><span class="pos-unit-warn">Only ${candidate.stock} pcs in stock.</span>` : "");
}

function confirmUnitPrompt() {
  if (!unitPrompt) return;
  const { candidate, unitId, memory } = unitPrompt;
  const v = readUnitInputs();
  let result;
  if (unitId === "piece") {
    if (!(v.count >= 1)) { $("pos-unit-summary").textContent = "Quantity must be at least 1."; return; }
    result = addPricedToCart(cart, candidate, Math.floor(v.count), {
      retail: $("pos-unit-retail")?.value, wholesale: $("pos-unit-ws")?.value, size: $("pos-unit-wssize")?.value
    });
    if (result.error) { $("pos-unit-summary").textContent = result.error; return; }
  } else {
    result = addUnitToCart(cart, candidate, { label: v.label, pieces: v.pieces, price: v.price }, v.count);
    if (result.error) { $("pos-unit-summary").textContent = result.error; return; }
    memory[unitId] = { pieces: Math.floor(v.pieces), price: round2(v.price) };
  }
  memory.last = unitId;
  const all = readUnitMemory();
  all[candidate.key] = memory;
  writeUnitMemory(all);
  closeUnitPrompt();
  applyCartResult(result);
}

function wireUnitPrompt() {
  $("pos-unit-options").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-unit]");
    if (!btn || !unitPrompt) return;
    unitPrompt.unitId = btn.dataset.unit;
    renderUnitPrompt();
  });
  $("pos-unit-fields").addEventListener("input", (event) => {
    if (!unitPrompt) return;
    if (event.target.id === "pos-unit-pieces") {
      const pieces = Number(event.target.value);
      const priceBox = $("pos-unit-price");
      if (priceBox && pieces >= 1 && !unitPrompt.priceTouched && unitPrompt.candidate.retailUnit != null) {
        priceBox.value = round2(pieces * unitPrompt.candidate.retailUnit);
      }
    }
    if (event.target.id === "pos-unit-price") unitPrompt.priceTouched = true;
    updateUnitSummary();
  });
  $("pos-unit-ok").addEventListener("click", confirmUnitPrompt);
  $("pos-unit-cancel").addEventListener("click", closeUnitPrompt);
  $("pos-unit-close").addEventListener("click", closeUnitPrompt);
  $("pos-unit-overlay").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); confirmUnitPrompt(); }
    if (event.key === "Escape") closeUnitPrompt();
  });
  const toggle = $("pos-ask-unit");
  toggle.checked = askUnitEnabled();
  toggle.addEventListener("change", () => {
    try { localStorage.setItem("almares_pos_ask_unit", toggle.checked ? "1" : "0"); } catch { /* optional */ }
  });
}

// ---------------- Edit one item of the sale: price, retail / wholesale, quantity (this sale only) ----------------
let editing = null;
const pesoText = (n) => (n == null || !Number.isFinite(n) ? "None" : formatMoney(n));

function openEditDialog(line) {
  const unit = !!line.saleUnit;
  editing = {
    key: line.key, unit, variation: "retail", qty: line.qty,
    retail: unit ? line.saleUnit.price : line.retailUnit,
    ws: unit ? null : (line.wholesaleUnit ?? null),
    size: wsSize(line), base: line
  };
  $("pos-edit-name").textContent = line.name;
  $("pos-edit-variation-box").hidden = unit;
  $("pos-edit-qty").value = line.qty;
  $("pos-edit-error").textContent = "";
  editing.unlocked = false;
  $("pos-edit-overlay").hidden = false;
  refreshEditFields();
  $("pos-edit-ok").focus({ preventScroll: true });
}
// The price is shown locked; the pencil unlocks it for typing.
function setPriceLocked(locked, focus) {
  if (!editing) return;
  editing.unlocked = !locked;
  const box = $("pos-edit-price");
  box.readOnly = locked;
  showEditPrice();
  $("pos-edit-pricebox")?.classList.toggle("is-editing", !locked);
  document.getElementById("pos-edit-pencil").classList.toggle("is-on", !locked);
  if (!locked && focus) { box.focus({ preventScroll: true }); box.select?.(); }
}
function closeEditDialog() {
  $("pos-edit-overlay").hidden = true;
  editing = null;
  focusScanInput();
}
// The single price box edits whichever chip is selected (retail or wholesale).
function showEditPrice() {
  if (!editing) return;
  const n = editing.variation === "ws" ? editing.ws : editing.retail;
  const box = $("pos-edit-price");
  // locked: "₱9.00"; while typing: the plain number
  box.value = n == null || !Number.isFinite(n) ? "" : editing.unlocked ? String(n) : formatMoney(n);
}
function readEditPrice() {
  if (!editing) return;
  const raw = $("pos-edit-price").value.replace(/[^\d.]/g, "");
  const n = raw === "" || raw === "." ? null : Number(raw);
  if (editing.variation === "ws") editing.ws = n;
  else editing.retail = n;
}
function refreshEditFields() {
  const e = editing;
  const ws = e.variation === "ws";
  $("pos-edit-price-label").textContent = e.unit ? `Price per ${e.base.saleUnit.label} (₱)` : ws ? "Wholesale price (₱) each" : "Retail price (₱) each";
  $("pos-edit-price").placeholder = ws ? "Type a wholesale price" : "₱0.00";
  $("pos-edit-chip-retail").textContent = pesoText(e.retail);
  $("pos-edit-chip-ws").textContent = e.ws == null ? "None — add" : pesoText(e.ws);
  setPriceLocked(!(e.unlocked || (ws && e.ws == null)), false); // no wholesale price yet: ready to type
  showEditPrice();
  document.querySelectorAll("#pos-edit-chips .pos-edit-chip").forEach((c) => c.classList.toggle("is-on", c.dataset.var === e.variation));
  $("pos-edit-size-box").hidden = !ws;
  $("pos-edit-size").value = e.size;
  updateEditSummary();
}
function updateEditSummary() {
  const e = editing; if (!e) return;
  const qty = Math.floor(Number($("pos-edit-qty").value));
  const out = $("pos-edit-summary");
  if (!(qty >= 1)) { out.textContent = ""; return; }
  if (e.unit) { out.innerHTML = `${qty} ${esc(e.base.saleUnit.label)} × ${formatMoney(e.retail || 0)} = <b>${formatMoney(round2(qty * (e.retail || 0)))}</b>`; return; }
  const size = Math.floor(Number($("pos-edit-size").value)) >= 2 ? Math.floor(Number($("pos-edit-size").value)) : e.size;
  const tmp = { qty, retailUnit: e.retail || 0, wholesaleUnit: e.ws, wsSize: size };
  const pr = linePricing(tmp);
  const parts = [];
  if (pr.groups > 0) parts.push(`${pr.wholesaleQty} pcs × ${formatMoney(e.ws)} (wholesale)`);
  if (pr.retailQty > 0 || !parts.length) parts.push(`${pr.retailQty} pc${pr.retailQty === 1 ? "" : "s"} × ${formatMoney(e.retail || 0)}`);
  out.innerHTML = `${parts.join(" + ")} = <b>${formatMoney(pr.total)}</b>`
    + (e.ws != null && pr.groups === 0 ? `<br><small>Wholesale applies from ${size} pcs.</small>` : "");
}
function confirmEditDialog() {
  const e = editing; if (!e) return;
  readEditPrice();
  e.size = Math.floor(Number($("pos-edit-size").value)) || e.size;
  const qty = Math.floor(Number($("pos-edit-qty").value));
  if (!(qty >= 1)) { $("pos-edit-error").textContent = "Quantity must be at least 1."; return; }
  let result = e.unit
    ? setUnitLinePrice(cart, e.key, e.retail)
    : setLinePrices(cart, e.key, { retail: e.retail, wholesale: e.ws, size: e.size });
  if (result.error) { $("pos-edit-error").textContent = result.error; return; }
  const sized = setLineQty(result.cart, e.key, qty);
  closeEditDialog();
  applyCartResult({ cart: sized.cart, error: sized.error });
}
function wireEditDialog() {
  $("pos-edit-chips").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-var]");
    if (!chip || !editing || chip.dataset.var === editing.variation) return;
    readEditPrice();
    editing.variation = chip.dataset.var;
    refreshEditFields();
    if (editing.unlocked) $("pos-edit-price").focus({ preventScroll: true });
  });
  $("pos-edit-pencil").addEventListener("click", () => setPriceLocked(!!editing?.unlocked, true));
  $("pos-edit-price").addEventListener("input", () => {
    const box = $("pos-edit-price");
    let v = box.value.replace(/[^\d.]/g, "");
    const dot = v.indexOf(".");
    if (dot !== -1) v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, "").slice(0, 2);
    box.value = v.slice(0, 10);
    readEditPrice(); const e = editing; if (e) { $("pos-edit-chip-retail").textContent = pesoText(e.retail); $("pos-edit-chip-ws").textContent = e.ws == null ? "None — add" : pesoText(e.ws); updateEditSummary(); } });
  $("pos-edit-size").addEventListener("input", updateEditSummary);
  $("pos-edit-qty").addEventListener("input", updateEditSummary);
  $("pos-edit-minus").addEventListener("click", () => { const n = Math.max(1, (Math.floor(Number($("pos-edit-qty").value)) || 1) - 1); $("pos-edit-qty").value = n; updateEditSummary(); });
  $("pos-edit-plus").addEventListener("click", () => { $("pos-edit-qty").value = (Math.floor(Number($("pos-edit-qty").value)) || 0) + 1; updateEditSummary(); });
  $("pos-edit-remove").addEventListener("click", () => { if (!editing) return; const key = editing.key; closeEditDialog(); applyCartResult({ cart: removeLine(cart, key) }); });
  $("pos-edit-ok").addEventListener("click", confirmEditDialog);
  $("pos-edit-close").addEventListener("click", closeEditDialog);
  $("pos-edit-overlay").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); confirmEditDialog(); }
    if (event.key === "Escape") closeEditDialog();
  });
}

// ---------------- Two steps: 1) build the sale, 2) confirm the items, then payment appears ----------------
let payStage = false;
function applyStage() {
  if (cart.length === 0) payStage = false;
  $("pos-payment").hidden = !payStage;
  $("pos-confirm").hidden = payStage;
  document.querySelector(".pos-cart")?.classList.toggle("is-paying", payStage);
  $("pos-confirm-go").disabled = cart.length === 0;
  $("pos-confirm-count").textContent = cart.length === 0 ? "No items yet" : `${cartUnits(cart)} item${cartUnits(cart) === 1 ? "" : "s"} · ${cart.length} product${cart.length === 1 ? "" : "s"}`;
  $("pos-confirm-total").textContent = formatMoney(cartTotal(cart));
}
function wireStages() {
  $("pos-confirm-go").addEventListener("click", () => {
    if (cart.length === 0) return;
    payStage = true;
    applyStage();
    renderPayment();
    $("pos-payment").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  $("pos-payment-back").addEventListener("click", () => { payStage = false; applyStage(); });
  $("pos-confirm-clear").addEventListener("click", () => $("pos-clear").click());
}

function applyCartResult(result) {
  if (result.error) showMessage(result.error, true); else hideMessage();
  cart = result.cart;
  payStage = false;
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
      const fresh = byKey.get(line.baseKey || line.key);
      if (!fresh) return null;
      const keepPrice = line.saleUnit || line.priceSet; // prices the cashier set at the counter stay as typed
      return {
        ...line,
        stock: fresh.stock ?? 0,
        retailUnit: keepPrice ? line.retailUnit : fresh.retailUnit,
        regularUnit: fresh.regularUnit,
        mode: line.mode === "wholesale" && (keepPrice ? line.wholesaleUnit : fresh.wholesaleUnit) == null ? "retail" : line.mode,
        discountPercent: keepPrice ? null : fresh.discountPercent,
        wholesaleUnit: line.saleUnit ? null : keepPrice ? line.wholesaleUnit : fresh.wholesaleUnit,
        qty: Math.min(line.qty, Math.floor(Math.max(fresh.stock ?? 0, 0) / (line.saleUnit ? line.saleUnit.pieces : 1)))
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

// Invoice-style rows for one line: quantity x rate = amount, wholesale group first.
function calcRows(line) {
  const pr = linePricing(line);
  if (line.saleUnit) {
    return [{ qty: `${line.qty} ${line.saleUnit.label}`, rate: `${formatMoney(line.saleUnit.price)} / ${line.saleUnit.label} (${line.saleUnit.pieces} pcs)`, tag: "", amount: formatMoney(pr.total) }];
  }
  const rows = [];
  if (pr.groups > 0) rows.push({ qty: pr.wholesaleQty, rate: formatMoney(line.wholesaleUnit), tag: "wholesale", amount: formatMoney(pr.wholesaleTotal) });
  if (pr.retailQty > 0 || pr.groups === 0) {
    rows.push({ qty: pr.retailQty, rate: formatMoney(line.retailUnit ?? 0), tag: line.discountPercent ? `-${line.discountPercent}%` : "", amount: formatMoney(pr.retailTotal) });
  }
  return rows;
}

function renderCart() {
  const box = $("pos-lines");
  if (cart.length === 0) {
    box.innerHTML = `<p class="notif-list__empty">No items yet. Scan or search to add.</p>`;
  } else {
    box.innerHTML = cart.map((line) => {
      const pr = linePricing(line);
      const k = esc(line.key);
      const size = wsSize(line);
      const pcs = (n) => `${n} pc${n === 1 ? "" : "s"}`;
      let rows;
      let note;
      if (line.saleUnit) {
        rows = `<div class="pos-ln"><span>${line.qty} ${esc(line.saleUnit.label)} × ${formatMoney(line.saleUnit.price)}</span><span>${formatMoney(pr.total)}</span></div>`;
        note = `${line.saleUnit.pieces} pcs per ${esc(line.saleUnit.label)} · ${stockQty(line)} pcs out of stock`;
      } else {
        rows = "";
        if (pr.groups > 0) rows += `<div class="pos-ln"><span>${pcs(pr.wholesaleQty)} × ${formatMoney(line.wholesaleUnit)} <em class="pos-tag">Wholesale</em></span><span>${formatMoney(pr.wholesaleTotal)}</span></div>`;
        if (pr.retailQty > 0 || pr.groups === 0) rows += `<div class="pos-ln"><span>${pcs(pr.retailQty)} × ${formatMoney(line.retailUnit ?? 0)}${pr.groups > 0 ? ` <em class="pos-tag pos-tag--reg">Regular</em>` : ""}${line.discountPercent ? ` <em class="pos-tag">-${line.discountPercent}%</em>` : ""}</span><span>${formatMoney(pr.retailTotal)}</span></div>`;
        note = line.wholesaleUnit != null
          ? `Wholesale ${formatMoney(line.wholesaleUnit)} each for every ${size} pcs${pr.groups > 0 ? ` · ${pr.groups} set${pr.groups === 1 ? "" : "s"} applied` : ` · buy ${size}+ to apply`}`
          : "No wholesale price";
      }
      return `
        <div class="pos-line">
          <div class="pos-line__info">
            <div class="pos-line__name">${esc(line.name)}</div>
            <div class="pos-ln-list">${rows}</div>
            <p class="pos-line__note">${note}</p>
          </div>
          <div class="pos-line__side">
            <strong class="pos-line__total">${formatMoney(lineTotal(line))}</strong>
            <button type="button" class="pos-line__edit" data-action="edit" data-key="${k}" aria-label="Edit ${esc(line.name)}">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z"/></svg>
              Edit
            </button>
          </div>
        </div>`;
    }).join("");
  }
  const discount = cartWholesaleDiscount(cart);
  $("pos-units").textContent = String(cartUnits(cart));
  $("pos-subtotal").textContent = formatMoney(cartRegularSubtotal(cart));
  $("pos-discount").textContent = `-${formatMoney(discount)}`;
  $("pos-discount-row").hidden = discount <= 0;
  $("pos-total").textContent = formatMoney(cartTotal(cart));
  applyStage();
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

// The box shows commas as you type (1,000), but everything else works with the plain number.
function formatTenderedDisplay(raw) {
  const v = String(raw ?? "");
  const dot = v.indexOf(".");
  const whole = (dot === -1 ? v : v.slice(0, dot)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return dot === -1 ? whole : whole + v.slice(dot);
}
function getTendered() {
  return $("pos-tendered").value.replace(/,/g, "");
}

function setTendered(value) {
  $("pos-tendered").value = formatTenderedDisplay(value);
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
  return computePayment(total, method, getTendered());
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

let lastSaleAttempt = null; // { id, sig }

async function commitSaleSupabase(ctx) {
  const { lines, productIds, saleRef, movementRefs, receiptNo, total, units, pay, cashierEmail } = ctx;

  const freshList = await SB.getProductsByIds(productIds);
  const fresh = new Map(freshList.map((p) => [p.id, p]));

  // Prices must still be what the cashier saw.
  for (const line of lines) {
    const data = fresh.get(line.productId);
    if (!data) throw new SaleError(`"${line.name}" no longer exists.`);
    const cand = candidatesForProduct(data).find((c) => c.key === (line.baseKey || line.key));
    if (!cand) throw new SaleError(`"${line.name}" is no longer available.`);
    if (line.saleUnit || line.priceSet) continue; // price was set at the counter
    const sameRetail = cand.retailUnit != null && Math.abs(cand.retailUnit - line.retailUnit) <= 0.001;
    const sameWholesale = (cand.wholesaleUnit ?? null) === (line.wholesaleUnit ?? null)
      || (cand.wholesaleUnit != null && line.wholesaleUnit != null && Math.abs(cand.wholesaleUnit - line.wholesaleUnit) <= 0.001);
    if (!sameRetail || !sameWholesale) {
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
    if (typeof now === "number") { m.newStock = now; m.previousStock = now + stockQty(lines[i]); }
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
    cashierName: cashierLabel(),
    cashierRole: currentRole,
    ...customerFields(saleCustomer)
  };

  try {
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
        const cand = candidatesForProduct({ id: line.productId, ...data }).find((c) => c.key === (line.baseKey || line.key));
        if (!cand) throw new SaleError(`"${line.name}" is no longer available.`);
        if (line.saleUnit || line.priceSet) continue; // price was set at the counter
        const sameRetail = cand.retailUnit != null && Math.abs(cand.retailUnit - line.retailUnit) <= 0.001;
        const sameWholesale = (cand.wholesaleUnit ?? null) === (line.wholesaleUnit ?? null)
          || (cand.wholesaleUnit != null && line.wholesaleUnit != null && Math.abs(cand.wholesaleUnit - line.wholesaleUnit) <= 0.001);
        if (!sameRetail || !sameWholesale) {
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
    cashierEmail, cashierName: cashierLabel(), when: new Date(),
    customerName: soldTo?.name || ""
  });
}

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

const customerSearchCache = new Map(); // typed text -> { at, list }
const CUSTOMER_LIMIT = 6;

function nameVariants(text) {
  const t = text.trim();
  const title = t.toLowerCase().replace(/(^|[\s\-.'])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
  const first = t.charAt(0).toUpperCase() + t.slice(1);
  return [...new Set([title, first, t.toLowerCase()])].filter(Boolean);
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

  const isNameSearch = !/^\+?\d{3,}$/.test(text.replace(/[\s\-()]/g, "")) && text.length >= 3;
  if (isNameSearch) {
    for (const [k, entry] of customerSearchCache) {
      if (entry.complete && key.startsWith(k) && Date.now() - entry.at < 60000) {
        const list = entry.list.filter((c) => c.name.toLowerCase().startsWith(key));
        customerSearchCache.set(key, { at: entry.at, list, complete: true });
        return list;
      }
    }
  }

  const jobs = [];
  const digits = text.replace(/[\s\-()]/g, "");
  if (/^\+?\d{3,}$/.test(digits)) {
    jobs.push(prefixQuery("mobileNumber", digits));
    if (digits.startsWith("0")) jobs.push(prefixQuery("mobileNumber", "+63" + digits.slice(1)));
  } else if (text.length >= 3) {
    nameVariants(text).forEach((v) => jobs.push(prefixQuery("fullName", v)));
  }
  let list = [];
  let complete = false;
  try {
    const settled = await Promise.all(jobs);
    complete = isNameSearch && settled.every((a) => a.length < CUSTOMER_LIMIT);
    const seen = new Map();
    settled.flat().forEach((c) => { if (c.name && !seen.has(c.uid)) seen.set(c.uid, c); });
    list = [...seen.values()];
  } catch (error) {
    console.error("Couldn't search customers:", error);
    return [];
  }
  customerSearchCache.set(key, { at: Date.now(), list, complete });
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
    customerTimer = setTimeout(showMatches, 600);
  });
  $("pos-customer-clear").addEventListener("click", () => setSaleCustomer(null));
}

// ----------------------------- RECEIPT --------------------------------
function showReceipt(sale) {
  const rows = sale.lines.map((l) => `
    <tr>
      <td>${esc(l.name)}<br>${calcRows(l).map((r) => `<small>${r.qty} × ${r.rate}${r.tag === "wholesale" ? " (wholesale)" : ""} = ${r.amount}</small>`).join("<br>")}</td>
      <td class="r">${formatMoney(lineTotal(l))}</td>
    </tr>`).join("");
  const receiptDiscount = cartWholesaleDiscount(sale.lines);

  $("pos-receipt").innerHTML = `
    <div class="pos-receipt__head">
      <strong>${STORE_NAME}</strong>
      <span>${esc(sale.receiptNo)}</span>
      <span>${esc(sale.when.toLocaleString())}</span>
      <span>Cashier: ${esc(sale.cashierName || sale.cashierEmail)}</span>
      ${sale.customerName ? `<span>Customer: ${esc(sale.customerName)}</span>` : ""}
    </div>
    <table>${rows}</table>
    <div class="pos-receipt__sum">
      <div><span>Items</span><span>${sale.units}</span></div>
      <div><span>Subtotal</span><span>${formatMoney(cartRegularSubtotal(sale.lines))}</span></div>
      ${receiptDiscount > 0 ? `<div><span>Wholesale discount</span><span>-${formatMoney(receiptDiscount)}</span></div>` : ""}
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
          <small>${item.priceMode === "unit" ? `${item.saleUnitCount} ${esc(item.saleUnit)} × ${formatMoney(item.saleUnitPrice)} (${item.qty} pcs)` : item.priceMode === "wholesale" ? `${item.qty} × ${formatMoney(item.unitPrice)} (wholesale)` : `${item.qty} × ${formatMoney(item.unitPrice)}`}${done ? ` · ${done} already refunded` : ""}</small>
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
        cashierName: cashierLabel(),
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
