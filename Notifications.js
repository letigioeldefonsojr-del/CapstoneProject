import { getProducts } from "./ProductCache.js";
import { getNotifications } from "./NotificationCache.js";
import { getReadSet, markRead, markAllRead, getClearedSet, markAllCleared, loadReadStatus } from "./ReadStatus.js";
import { confirmDialog } from "./ConfirmDialog.js";

// ====================================================================
// CHUNK 0 — CONFIG
// ----------------------------------------------------------------
// Two sources feed this page, both readable by Admin AND Employee
// now (per the updated Firestore rules — see firestore.rules):
// real order notifications from employeeNotifications, and
// synthesized stock alerts computed live from products.
//
// Read/cleared state is tracked per-UID (ReadStatus.js), not per
// browser — so clearing as one account never affects what another
// account sees, even when testing both in the same browser.
// ====================================================================
const STOCK_FIELD = "stockCount";
const PRODUCT_AVAILABLE_FIELD = "available";
const PRODUCT_NAME_FIELD = "name";
const LOW_STOCK_THRESHOLD = 99;
const CRITICAL_STOCK_THRESHOLD = 49;

let currentUid = null;
let orderItems = [];  // [{ id, type:"order", message, timeLabel }]
let stockItems = [];  // [{ id, type:"stock", message, filterValue }]
let activeTab = "all";

// ====================================================================
// CHUNK 1 — WAIT FOR THE SHARED SIDEBAR (auth guard lives there)
// ====================================================================
document.addEventListener("sidebar:ready", async (event) => {
  currentUid = event.detail.user.uid;
  await loadReadStatus(currentUid);
  wireTabs();
  wireMarkAllRead();
  wireClearAll();
  loadEverything();
});

// ====================================================================
// CHUNK 2 — LOAD BOTH SOURCES
// ----------------------------------------------------------------
// Cleared items are filtered out right here, at load time — once
// cleared, they're just gone for this account until the underlying
// thing changes (a new order notification is a new doc ID; a stock
// alert only reappears if it goes back to "in" and then drops again).
// ====================================================================
async function loadEverything() {
  await Promise.all([loadStockAlerts(), loadOrderNotifications()]);
  render();
}

async function loadStockAlerts() {
  try {
    const products = await getProducts();
    const clearedSet = getClearedSet(currentUid);

    stockItems = products
      .map((product) => {
        const status = getStockStatus(product[STOCK_FIELD], product[PRODUCT_AVAILABLE_FIELD]);
        if (status === "in") return null;
        const id = `stock-${product.id}`;
        if (clearedSet.has(id)) return null;
        return {
          id,
          type: "stock",
          message: buildStockMessage(product, status),
          filterValue: status
        };
      })
      .filter(Boolean);
  } catch (error) {
    console.error("Couldn't load stock alerts:", error);
    stockItems = [];
  }
}

function getStockStatus(stock, isAvailable) {
  if (isAvailable === false || stock === 0) return "out";
  if (typeof stock !== "number") return "unknown";
  if (stock <= CRITICAL_STOCK_THRESHOLD) return "critical";
  if (stock <= LOW_STOCK_THRESHOLD) return "low";
  return "in";
}

function buildStockMessage(product, status) {
  const name = product[PRODUCT_NAME_FIELD] || "A product";
  const stock = product[STOCK_FIELD];
  if (status === "out") return `${name} is out of stock.`;
  if (status === "critical") return `${name} is critically low — only ${stock} left.`;
  if (status === "unknown") return `${name} has no stock count set.`;
  return `${name} is running low — ${stock} left.`;
}

async function loadOrderNotifications() {
  try {
    const notifications = await getNotifications();
    const clearedSet = getClearedSet(currentUid);

    orderItems = notifications
      .filter((n) => !clearedSet.has(n.id))
      .sort((a, b) => (b.createdAtMillis || 0) - (a.createdAtMillis || 0))
      .map((n) => ({
        id: n.id,
        type: "order",
        message: n.message,
        timeLabel: n.createdAtMillis
          ? new Date(n.createdAtMillis).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
          : ""
      }));
  } catch (error) {
    console.error("Couldn't load order notifications:", error);
    orderItems = [];
  }
}

// ====================================================================
// CHUNK 3 — TABS
// ====================================================================
function wireTabs() {
  document.querySelectorAll(".tab-row__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      document.querySelectorAll(".tab-row__btn").forEach((b) => b.classList.toggle("is-active", b === btn));
      render();
    });
  });
}

// ====================================================================
// CHUNK 4 — RENDER
// ----------------------------------------------------------------
// "All" shows both groups with section headers. "Orders" / "Stock
// Alerts" show just that one list. Clear All acts on whatever's
// currently visible in the active tab.
// ====================================================================
function render() {
  const list = document.getElementById("full-notif-list");
  const clearBtn = document.getElementById("clear-all-btn");
  const readSet = getReadSet(currentUid);

  const showStock = activeTab === "all" || activeTab === "stock";
  const showOrders = activeTab === "all" || activeTab === "orders";

  const visibleCount =
    (showStock ? stockItems.length : 0) + (showOrders ? orderItems.length : 0);
  clearBtn.disabled = visibleCount === 0;

  list.innerHTML = "";

  if (showStock && stockItems.length > 0) {
    if (activeTab === "all") list.appendChild(buildSectionHeader("Stock Alerts"));
    stockItems.forEach((item) => list.appendChild(buildStockListItem(item, readSet.has(item.id))));
  }

  if (showOrders && orderItems.length > 0) {
    if (activeTab === "all") list.appendChild(buildSectionHeader("Order Notifications"));
    orderItems.forEach((item) => list.appendChild(buildOrderListItem(item, readSet.has(item.id))));
  }

  if (list.children.length === 0) {
    list.innerHTML = `<li class="notif-list__empty">Nothing here.</li>`;
  }
}

function buildSectionHeader(text) {
  const header = document.createElement("li");
  header.className = "notif-list__section";
  header.textContent = text;
  return header;
}

// Stock alert click → jump to Inventory pre-filtered to that severity.
function buildStockListItem(item, alreadyRead) {
  const el = document.createElement("li");
  el.className = "notif-list__item notif-list__item--clickable";
  if (!alreadyRead) el.classList.add("is-unread");

  el.innerHTML = `
    ${!alreadyRead ? '<span class="notif-list__dot"></span>' : '<span class="notif-list__dot notif-list__dot--spacer"></span>'}
    <div class="notif-list__body">
      <span class="notif-list__message"></span>
    </div>
  `;
  el.querySelector(".notif-list__message").textContent = item.message;

  el.addEventListener("click", async (event) => {
    event.preventDefault();
    await markRead(currentUid, item.id);
    window.location.href = `Inventory.html?filter=${item.filterValue}`;
  });

  return el;
}

// Order notification click → mark read, jump to Orders.
function buildOrderListItem(item, alreadyRead) {
  const el = document.createElement("li");
  el.className = "notif-list__item notif-list__item--clickable";
  if (!alreadyRead) el.classList.add("is-unread");

  el.innerHTML = `
    ${!alreadyRead ? '<span class="notif-list__dot"></span>' : '<span class="notif-list__dot notif-list__dot--spacer"></span>'}
    <div class="notif-list__body">
      <span class="notif-list__message"></span>
      <span class="notif-list__time"></span>
    </div>
  `;
  el.querySelector(".notif-list__message").textContent = item.message;
  el.querySelector(".notif-list__time").textContent = item.timeLabel;

  el.addEventListener("click", async (event) => {
    event.preventDefault();
    await markRead(currentUid, item.id);
    window.location.href = "Orders.html";
  });

  return el;
}

// ====================================================================
// CHUNK 5 — MARK ALL AS READ (per-uid, cosmetic — items stay visible)
// ====================================================================
function wireMarkAllRead() {
  document.getElementById("mark-all-read-btn").addEventListener("click", () => {
    const allIds = [...stockItems, ...orderItems].map((item) => item.id);
    markAllRead(currentUid, allIds);
    render();
  });
}

// ====================================================================
// CHUNK 6 — CLEAR ALL
// ----------------------------------------------------------------
// This is the fix for "clearing employee's notifications shouldn't
// touch admin's (or another employee's)": nothing is deleted from
// Firestore. It marks whatever's visible in the CURRENT tab as
// cleared for THIS account only (ReadStatus.js, keyed by uid), then
// re-renders with those items filtered out. Every other account's
// view of the same underlying data is completely unaffected.
// ====================================================================
function wireClearAll() {
  document.getElementById("clear-all-btn").addEventListener("click", async () => {
    const showStock = activeTab === "all" || activeTab === "stock";
    const showOrders = activeTab === "all" || activeTab === "orders";

    const idsToClear = [
      ...(showStock ? stockItems : []),
      ...(showOrders ? orderItems : [])
    ].map((item) => item.id);

    if (idsToClear.length === 0) return;

    const confirmed = await confirmDialog(
      "This only affects your account — nothing is deleted for anyone else.",
      {
        title: `Clear ${idsToClear.length} notification${idsToClear.length === 1 ? "" : "s"}?`,
        confirmLabel: "Clear"
      }
    );
    if (!confirmed) return;

    markAllCleared(currentUid, idsToClear);

    if (showStock) stockItems = stockItems.filter((item) => !idsToClear.includes(item.id));
    if (showOrders) orderItems = orderItems.filter((item) => !idsToClear.includes(item.id));

    render();
  });
}
