// notifications — Notifications page for admin and employees.

import { getWorstAlertDetail } from "./StockAlerts.js";
import { getReadSet, markRead, markAllRead, getClearedSet, markAllCleared, loadReadStatus } from "./ReadStatus.js";
import { confirmDialog } from "./ConfirmDialog.js";
import { getLatestProducts, getLatestNotifications } from "./Sidebar.js";

const PRODUCT_NAME_FIELD = "name";

let currentUid = null;
let currentPreferences = { stockAlerts: true, orderNotifications: true };
let orderItems = [];  // [{ id, type:"order", message, timeLabel }]
let stockItems = [];  // [{ id, type:"stock", message, filterValue }]
let activeTab = "all";

document.addEventListener("sidebar:ready", async (event) => {
  currentUid = event.detail.user.uid;
  currentPreferences = event.detail.preferences || currentPreferences;
  await loadReadStatus(currentUid);
  wireTabs();
  wireMarkAllRead();
  wireClearAll();
  loadEverything();
});

function loadEverything() {
  function renderStockItems(products) {
    if (!currentPreferences.stockAlerts) {
      stockItems = [];
      render();
      return;
    }

    const clearedSet = getClearedSet(currentUid);

    stockItems = products
      .map((product) => {
        const detail = getWorstAlertDetail(product);
        if (!detail) return null;
        const id = `stock-${product.id}-${detail.status}`;
        if (clearedSet.has(id)) return null;
        return {
          id,
          type: "stock",
          message: buildStockMessage(product, detail),
          filterValue: detail.status
        };
      })
      .filter(Boolean);

    render();
  }

  function renderOrderItems(notifications) {
    if (!currentPreferences.orderNotifications) {
      orderItems = [];
      render();
      return;
    }

    const clearedSet = getClearedSet(currentUid);

    orderItems = notifications
      .map((data) => {
        const millis = data.createdAt?.toMillis?.() || null;
        return {
          id: data.id,
          type: "order",
          message: data.message || "New notification",
          orderId: data.orderId || null,
          createdAtMillis: millis,
          timeLabel: millis
            ? new Date(millis).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
            : ""
        };
      })
      .filter((n) => !clearedSet.has(n.id))
      .sort((a, b) => (b.createdAtMillis || 0) - (a.createdAtMillis || 0));

    render();
  }

  const existingProducts = getLatestProducts();
  if (existingProducts) renderStockItems(existingProducts);
  document.addEventListener("products:live", (event) => renderStockItems(event.detail.products));

  const existingNotifications = getLatestNotifications();
  if (existingNotifications) renderOrderItems(existingNotifications);
  document.addEventListener("notifications:live", (event) => renderOrderItems(event.detail.notifications));
}

function buildStockMessage(product, detail) {
  const name = product[PRODUCT_NAME_FIELD] || "A product";
  const label = detail.variantLabel ? `${name} (${detail.variantLabel})` : name;
  if (detail.status === "out") return `${label} is out of stock.`;
  if (detail.status === "critical") return `${label} is critically low — only ${detail.stock} left.`;
  if (detail.status === "unknown") return `${label} has no stock count set.`;
  return `${label} is running low — ${detail.stock} left.`;
}

function wireTabs() {
  document.querySelectorAll(".tab-row__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      document.querySelectorAll(".tab-row__btn").forEach((b) => b.classList.toggle("is-active", b === btn));
      render();
    });
  });
}

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

  if (activeTab === "all" && stockItems.length > 0 && orderItems.length > 0) {
    list.appendChild(buildJumpLinksRow());
  }

  if (showStock && stockItems.length > 0) {
    if (activeTab === "all") list.appendChild(buildSectionHeader("Stock Alerts", stockItems.length, "section-stock-alerts"));
    stockItems.forEach((item) => list.appendChild(buildStockListItem(item, readSet.has(item.id))));
  }

  if (showOrders && orderItems.length > 0) {
    if (activeTab === "all") list.appendChild(buildSectionHeader("Order Notifications", orderItems.length, "section-order-notifications"));
    orderItems.forEach((item) => list.appendChild(buildOrderListItem(item, readSet.has(item.id))));
  }

  if (list.children.length === 0) {
    list.innerHTML = `<li class="notif-list__empty">Nothing here.</li>`;
  }
}

function buildJumpLinksRow() {
  const row = document.createElement("li");
  row.className = "notif-list__jump-row";
  row.innerHTML = `
    <button type="button" class="notif-list__jump-link" data-jump="section-stock-alerts">↓ Stock Alerts (${stockItems.length})</button>
    <button type="button" class="notif-list__jump-link" data-jump="section-order-notifications">↓ Order Notifications (${orderItems.length})</button>
  `;
  row.querySelectorAll("[data-jump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById(btn.dataset.jump)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  return row;
}

function buildSectionHeader(text, count, id) {
  const header = document.createElement("li");
  header.className = "notif-list__section";
  header.id = id;
  header.textContent = `${text} (${count})`;
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
    try {
      await markRead(currentUid, item.id);
    } catch (error) {
      console.error("Couldn't save read status:", error);
    }
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
    try {
      await markRead(currentUid, item.id);
    } catch (error) {
      console.error("Couldn't save read status:", error);
    }
    window.location.href = item.orderId ? `Orders.html?orderId=${item.orderId}` : "Orders.html";
  });

  return el;
}

function wireMarkAllRead() {
  document.getElementById("mark-all-read-btn").addEventListener("click", () => {
    const allIds = [...stockItems, ...orderItems].map((item) => item.id);
    markAllRead(currentUid, allIds);
    document.dispatchEvent(new CustomEvent("readstatus:changed"));
    render();
  });
}

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
    document.dispatchEvent(new CustomEvent("readstatus:changed"));

    if (showStock) stockItems = stockItems.filter((item) => !idsToClear.includes(item.id));
    if (showOrders) orderItems = orderItems.filter((item) => !idsToClear.includes(item.id));

    render();
  });
}
