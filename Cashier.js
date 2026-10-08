import { db } from "./firebase-config.js";
import {
  collection, doc, runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getProducts, invalidateProductsCache } from "./ProductCache.js";
import {
  candidatesForProduct, findCandidateByBarcode, searchProducts,
  addToCart, setLineQty, setLineMode, removeLine,
  lineUnitPrice, lineTotal, cartTotal, cartUnits,
  computePayment, planStockUpdates, makeReceiptNo, buildSaleItems, formatMoney
} from "./CashierLogic.js";

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

let products = [];
let cart = [];
let method = "cash";
let currentUser = null;
let currentRole = "employee";
let busy = false;
let lastLoadedAt = 0;
let searchTimer = null;

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

document.addEventListener("sidebar:ready", async (event) => {
  currentUser = event.detail.user;
  currentRole = event.detail.role || "employee";
  wireUi();
  await loadProducts();
  renderAll();
  $("pos-input").focus();
});

async function loadProducts() {
  invalidateProductsCache();
  try {
    products = await getProducts();
    lastLoadedAt = Date.now();
  } catch (error) {
    console.error("Couldn't load products:", error);
    showMessage("Couldn't load products. Check the connection and refresh.", true);
  }
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
    searchTimer = setTimeout(renderResults, 120);
  });

  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    const hit = findCandidateByBarcode(products, value);
    if (hit) {
      add(hit);
    } else {
      const first = searchProducts(products, value)
        .flatMap((p) => candidatesForProduct(p))
        .find((c) => c.inStock);
      if (first) add(first);
      else showMessage(`Nothing in stock matches "${value}".`, true);
    }
    input.value = "";
    renderResults();
  });

  $("pos-results").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-add-key]");
    if (!btn) return;
    const candidate = allCandidates().find((c) => c.key === btn.dataset.addKey);
    if (candidate) add(candidate);
    input.focus();
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

  $("pos-tendered").addEventListener("input", renderPayment);
  $("pos-clear").addEventListener("click", () => {
    if (cart.length === 0) return;
    cart = [];
    $("pos-tendered").value = "";
    $("pos-gcash-ref").value = "";
    renderAll();
    $("pos-input").focus();
  });
  $("pos-complete").addEventListener("click", completeSale);

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
  window.addEventListener("focus", async () => {
    if (!busy && Date.now() - lastLoadedAt > 60000) {
      await loadProducts();
      refreshCartFromProducts();
      renderAll();
    }
  });
}

function allCandidates() {
  return products.flatMap((p) => candidatesForProduct(p));
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
  if (!term) { box.innerHTML = ""; return; }

  const rows = searchProducts(products, term).flatMap((p) => candidatesForProduct(p));
  if (rows.length === 0) {
    box.innerHTML = `<p class="notif-list__empty">No products match "${esc(term)}".</p>`;
    return;
  }
  box.innerHTML = rows.slice(0, 40).map((c) => `
    <div class="pos-result ${c.inStock ? "" : "is-out"}">
      <div class="pos-result__info">
        <span class="pos-result__name">${esc(c.name)}</span>
        <span class="pos-result__meta">
          ${c.discountPercent ? `<s>${formatMoney(c.regularUnit)}</s> ` : ""}${c.retailUnit != null ? formatMoney(c.retailUnit) : "No price"}
          ${c.wholesaleUnit != null ? ` · Wholesale ${formatMoney(c.wholesaleUnit)}` : ""}
          · ${c.inStock ? `${c.stock} in stock` : "Out of stock"}
        </span>
      </div>
      <button type="button" class="btn-outline" data-add-key="${esc(c.key)}" ${c.inStock && c.retailUnit != null ? "" : "disabled"}>Add</button>
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
              <input type="number" min="1" max="${line.stock}" value="${line.qty}" data-qty-input="${esc(line.key)}">
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

function paymentState() {
  const total = cartTotal(cart);
  return computePayment(total, method, $("pos-tendered").value);
}

function renderPayment() {
  const cash = method === "cash";
  $("pos-cash-field").hidden = !cash;
  $("pos-gcash-field").hidden = cash;
  $("pos-change-row").hidden = !cash;

  const pay = paymentState();
  $("pos-change").textContent = formatMoney(pay.ok ? pay.change : 0);

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
  const saleRef = doc(collection(db, "posSales"));
  const movementRefs = lines.map(() => doc(collection(db, "stockMovements")));
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const cashierEmail = currentUser?.email || "unknown";

  try {
    await runTransaction(db, async (tx) => {
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

      for (const [productId, update] of plan.updates) {
        tx.update(doc(db, "products", productId), update);
      }

      tx.set(saleRef, {
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
        createdAt: serverTimestamp()
      });

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
      await loadProducts();
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

  busy = false;
  btn.textContent = "Complete sale";
  showReceipt({
    receiptNo, lines, total, units,
    paymentMethod: method, tendered: pay.tendered, change: pay.change,
    gcashRef: method === "gcash" ? $("pos-gcash-ref").value.trim() : "",
    cashierEmail, when: new Date()
  });
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
  $("pos-input").value = "";
  await loadProducts();      // stock just changed — show fresh numbers
  renderAll();
  $("pos-input").focus();
}
