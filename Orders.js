import { db } from "./firebase-config.js";
import {
  collection, doc, updateDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { confirmDialog } from "./ConfirmDialog.js";

// ====================================================================
// CHUNK 0 — CONFIG
// ----------------------------------------------------------------
// Schema confirmed directly from your mobile app's main.dart, not
// guessed: orders/{orderId} has userId, customerName, customerAddress,
// total, itemCount, items[] ({productId, productName, imageUrl,
// flavor, amount, unitPrice, subtotal}), status, createdAt,
// estimatedDelivery, and (once marked delivered) awaitingCustomer-
// Confirmation / isPaid / confirmDeadline.
//
// This page works for both Employee and Admin — your Firestore rules
// grant orders read/write to isEmployee() || isAdmin().
//
// NOT replicated here: your mobile app calls notifyCustomerOrderUpdate
// (OneSignal push) after every status change. That's a server-side
// concern (needs an API key that shouldn't live in client JS) — status
// updates from this page will NOT push a notification to the
// customer's phone. Worth building as a Cloud Function later if you
// want web actions to notify customers too.
// ====================================================================
const ORDERS_COLLECTION = "orders";

// UPDATE THIS after deploying onesignal-worker.js — shown in the
// Cloudflare dashboard right after deployment, same pattern as the
// Gemini Worker URL.
const NOTIFICATION_WORKER_URL = "https://onesignal-notify.eldefonsojrletigio.workers.dev";

// "Rejected" folds into the Cancelled tab (both mean the order never
// proceeded); "Undelivered" gets its own tab since it's a distinct
// state your staff need to follow up on.
const TAB_STATUS_MAP = {
  all: null,
  pending: ["pending"],
  approved: ["approved"],
  on_the_way: ["on_the_way"],
  delivered: ["delivered"],
  cancelled: ["cancelled", "rejected"],
  undelivered: ["undelivered"]
};

const STATUS_META = {
  pending: { label: "Pending", badgeClass: "order-badge--pending" },
  approved: { label: "Approved", badgeClass: "order-badge--approved" },
  on_the_way: { label: "On the Way", badgeClass: "order-badge--on-the-way" },
  delivered: { label: "Delivered", badgeClass: "order-badge--delivered" },
  cancelled: { label: "Cancelled", badgeClass: "order-badge--cancelled" },
  rejected: { label: "Rejected", badgeClass: "order-badge--cancelled" },
  undelivered: { label: "Unable to Deliver", badgeClass: "order-badge--cancelled" }
};

let allOrders = [];
let searchQuery = "";
let sortOrder = "newest"; // "newest" | "oldest"
let groupBy = "none"; // "none" | "week" | "month" | "year"
let activeTab = "all";
let cancelledSubStatus = "cancelled"; // when activeTab === "cancelled": "cancelled" or "rejected"
let expandedOrderDetail = null;   // accordion: only one order's detail row open at a time
let expandedOrderMainRow = null;
let currentRole = "employee";
let pendingUndeliverableOrderId = null;

// ====================================================================
// CHUNK 1 — WAIT FOR THE SHARED SIDEBAR (auth guard lives there)
// ====================================================================
document.addEventListener("sidebar:ready", (event) => {
  currentRole = event.detail.role;

  wireTabs();
  wireSearch();
  wireSort();
  wireUndeliverableModal();
  loadOrders();
});

// ====================================================================
// CHUNK 2 — LOAD ORDERS
// ====================================================================
function loadOrders() {
  // Real-time: set up ONCE. Fires immediately with current data, then
  // again automatically whenever anything in this collection changes
  // — a staff action here (Approve, Mark Delivered, etc.) OR a
  // customer-side update from the mobile app (confirming they
  // received their order, submitting a rating, cancelling). No manual
  // reload needed on either side.
  onSnapshot(
    collection(db, ORDERS_COLLECTION),
    (snap) => {
      allOrders = snap.docs
        .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
        .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));

      updateCounts();
      render();
    },
    (error) => {
      console.error("Couldn't load orders:", error);
      document.getElementById("orders-tbody").innerHTML =
        `<tr><td colspan="7" class="inventory-empty">Couldn't load orders right now.</td></tr>`;
    }
  );
}

// No longer needed for its own sake — the onSnapshot listener above
// already catches every change (including the ones this function used
// to be called after) automatically and near-instantly. Kept as a
// harmless no-op rather than removing every call site, so nothing
// breaks if it's called from somewhere.
async function reloadAfterAction() {}

// ====================================================================
// CHUNK 3 — STATUS COUNT / TAB CARDS
// ====================================================================
function updateCounts() {
  document.getElementById("count-all").textContent = allOrders.length;
  Object.entries(TAB_STATUS_MAP).forEach(([tab, statuses]) => {
    if (tab === "all") return;
    const count = allOrders.filter((o) => statuses.includes(o.status)).length;
    const el = document.getElementById(`count-${tab}`);
    if (el) el.textContent = count;
  });
}

function wireTabs() {
  document.querySelectorAll(".order-status-card").forEach((card) => {
    card.addEventListener("click", () => {
      activeTab = card.dataset.status;
      cancelledSubStatus = "cancelled"; // reset to default each time Cancelled is (re)selected
      document.querySelectorAll("#cancelled-subtabs .tab-row__btn").forEach((b) =>
        b.classList.toggle("is-active", b.dataset.substatus === "cancelled")
      );
      document.querySelectorAll(".order-status-card").forEach((c) =>
        c.classList.toggle("is-active", c === card)
      );
      render();
    });
  });

  document.querySelectorAll("#cancelled-subtabs .tab-row__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      cancelledSubStatus = btn.dataset.substatus;
      document.querySelectorAll("#cancelled-subtabs .tab-row__btn").forEach((b) =>
        b.classList.toggle("is-active", b === btn)
      );
      render();
    });
  });
}

function wireSearch() {
  document.getElementById("orders-search-input").addEventListener("input", (event) => {
    searchQuery = event.target.value;
    render();
  });
}

function ordersForActiveTab() {
  let orders;
  if (activeTab === "cancelled") {
    orders = allOrders.filter((o) => o.status === cancelledSubStatus);
  } else {
    const statuses = TAB_STATUS_MAP[activeTab];
    orders = !statuses ? allOrders : allOrders.filter((o) => statuses.includes(o.status));
  }

  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    orders = orders.filter((order) => {
      const idMatch = shortOrderId(order.id).toLowerCase().includes(q);
      const nameMatch = (order.customerName || "").toLowerCase().includes(q);
      const dateMatch = formatOrderDate(order).toLowerCase().includes(q);
      return idMatch || nameMatch || dateMatch;
    });
  }

  return [...orders].sort((a, b) => {
    const aMillis = a.createdAt?.toMillis?.() || 0;
    const bMillis = b.createdAt?.toMillis?.() || 0;
    return sortOrder === "newest" ? bMillis - aMillis : aMillis - bMillis;
  });
}

function buildGroupHeaderRow(label) {
  const row = document.createElement("tr");
  row.className = "orders-group-header-row";
  row.innerHTML = `<td colspan="7">${label}</td>`;
  return row;
}

// Computes which time-period bucket an order belongs to, based on the
// current groupBy setting — used to insert section headers ("August
// 2026", "Week of Aug 18, 2026", etc.) between orders in the table.
function getGroupLabel(order) {
  const millis = order.createdAt?.toMillis?.();
  if (!millis) return "Unknown date";

  const date = new Date(millis);

  if (groupBy === "year") {
    return String(date.getFullYear());
  }
  if (groupBy === "month") {
    return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }
  if (groupBy === "week") {
    const weekStart = new Date(date);
    weekStart.setDate(date.getDate() - date.getDay()); // back up to that week's Sunday
    return `Week of ${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  }
  return null; // "none" — no grouping
}

function wireSort() {
  document.getElementById("orders-sort-select").addEventListener("change", (event) => {
    sortOrder = event.target.value;
    render();
  });
  document.getElementById("orders-group-select").addEventListener("change", (event) => {
    groupBy = event.target.value;
    render();
  });
}

// ====================================================================
// CHUNK 4 — RENDER TABLE
// ====================================================================
function render() {
  document.getElementById("cancelled-subtabs").hidden = activeTab !== "cancelled";

  // Remember which order was expanded before rebuilding the table, so
  // a live update elsewhere doesn't silently collapse whatever the
  // admin is currently looking at.
  const previouslyExpandedOrderId = expandedOrderMainRow?.dataset.orderId || null;
  expandedOrderDetail = null;
  expandedOrderMainRow = null;

  const tbody = document.getElementById("orders-tbody");
  const orders = ordersForActiveTab();

  if (orders.length === 0) {
    const message = searchQuery.trim() ? "No orders match your search." : "No orders here.";
    tbody.innerHTML = `<tr><td colspan="7" class="inventory-empty">${message}</td></tr>`;
    return;
  }

  tbody.innerHTML = "";
  let lastGroupLabel = undefined; // undefined (not null) so the very first order always triggers a header when grouping is on
  orders.forEach((order) => {
    if (groupBy !== "none") {
      const label = getGroupLabel(order);
      if (label !== lastGroupLabel) {
        tbody.appendChild(buildGroupHeaderRow(label));
        lastGroupLabel = label;
      }
    }

    const mainRow = buildOrderRow(order);
    mainRow.dataset.orderId = order.id;
    tbody.appendChild(mainRow);

    const detailRow = buildOrderDetailRow(order);
    detailRow.hidden = true;
    tbody.appendChild(detailRow);

    mainRow.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      const expanding = detailRow.hidden;

      // Accordion: collapse whichever row was previously open, if any.
      if (expandedOrderDetail && expandedOrderDetail !== detailRow) {
        expandedOrderDetail.hidden = true;
        expandedOrderMainRow.classList.remove("is-expanded");
      }

      detailRow.hidden = !expanding;
      mainRow.classList.toggle("is-expanded", expanding);
      expandedOrderDetail = expanding ? detailRow : null;
      expandedOrderMainRow = expanding ? mainRow : null;
    });

    if (order.id === previouslyExpandedOrderId) {
      detailRow.hidden = false;
      mainRow.classList.add("is-expanded");
      expandedOrderDetail = detailRow;
      expandedOrderMainRow = mainRow;
    }
  });
}

function shortOrderId(id) {
  return id.slice(0, 8).toUpperCase();
}

// Fire-and-forget — a failed push notification shouldn't block or
// undo the actual order status change, which already succeeded in
// Firestore by the time this runs. Requires the Flutter app to have
// called OneSignal.login(firebaseUid) after the customer signed in —
// without that link on the mobile side, this will run without error
// but the notification won't reach anyone yet.
async function sendOrderNotification(order, title, message) {
  if (!order.userId) {
    console.warn("Order has no userId on file — skipping push notification.");
    return;
  }

  try {
    const response = await fetch(NOTIFICATION_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUid: order.userId, title, message })
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      console.error("Push notification failed:", detail);
    }
  } catch (error) {
    console.error("Couldn't send push notification:", error);
  }
}

function formatOrderDate(order) {
  const millis = order.createdAt?.toMillis?.();
  if (!millis) return "—";
  return new Date(millis).toLocaleDateString(undefined, { dateStyle: "medium" });
}

function buildOrderRow(order) {
  const row = document.createElement("tr");
  row.className = "inventory-row inventory-row--expandable";

  const meta = STATUS_META[order.status] || { label: order.status || "Unknown", badgeClass: "order-badge--pending" };
  const items = Array.isArray(order.items) ? order.items : [];
  const itemsSummary = items.length === 0
    ? "—"
    : items.length === 1
      ? (items[0].productName || "1 item")
      : `${items[0].productName || "Item"} +${items.length - 1} more`;

  row.innerHTML = `
    <td class="orders-table__id"></td>
    <td></td>
    <td></td>
    <td></td>
    <td></td>
    <td></td>
    <td class="orders-table__actions"></td>
  `;

  const cells = row.querySelectorAll("td");
  cells[0].textContent = `#${shortOrderId(order.id)}`;
  cells[1].textContent = order.customerName || "—";
  cells[2].textContent = itemsSummary;
  cells[3].textContent = typeof order.total === "number" ? `₱${order.total.toFixed(2)}` : "—";
  cells[4].textContent = formatOrderDate(order);

  const badge = document.createElement("span");
  badge.className = `order-badge ${meta.badgeClass}`;
  badge.textContent = order.awaitingCustomerConfirmation ? "Awaiting Confirmation" : meta.label;
  cells[5].appendChild(badge);

  cells[6].appendChild(buildActionsForOrder(order));

  return row;
}

function buildOrderDetailRow(order) {
  const row = document.createElement("tr");
  row.className = "inventory-variant-row";

  const cell = document.createElement("td");
  cell.colSpan = 7;

  const wrap = document.createElement("div");
  wrap.className = "order-detail";

  const addressLine = document.createElement("p");
  addressLine.className = "order-detail__address";
  addressLine.textContent = order.customerAddress ? `Deliver to: ${order.customerAddress}` : "No address on file.";
  wrap.appendChild(addressLine);

  const items = Array.isArray(order.items) ? order.items : [];
  const list = document.createElement("div");
  list.className = "variant-list";

  items.forEach((item) => {
    const line = document.createElement("div");
    line.className = "variant-list__item";

    const thumb = item.imageUrl ? document.createElement("img") : document.createElement("span");
    thumb.className = "variant-list__thumb";
    if (item.imageUrl) {
      thumb.src = item.imageUrl;
      thumb.alt = "";
      thumb.loading = "lazy";
    } else {
      thumb.classList.add("variant-list__thumb--empty");
    }
    line.appendChild(thumb);

    const name = document.createElement("span");
    name.className = "variant-list__name";
    name.textContent = item.flavor ? `${item.productName} — ${item.flavor}` : (item.productName || "Item");
    line.appendChild(name);

    const qty = document.createElement("span");
    qty.className = "variant-list__stock";
    qty.textContent = `× ${item.amount ?? 1}`;
    line.appendChild(qty);

    const subtotal = document.createElement("span");
    subtotal.className = "variant-list__price";
    subtotal.textContent = typeof item.subtotal === "number" ? `₱${item.subtotal.toFixed(2)}` : "—";
    line.appendChild(subtotal);

    list.appendChild(line);
  });

  wrap.appendChild(list);

  if (order.deliveryIssueReason) {
    const reasonLine = document.createElement("p");
    reasonLine.className = "order-detail__reason";
    reasonLine.textContent = `Delivery issue: ${order.deliveryIssueReason}`;
    wrap.appendChild(reasonLine);
  }

  cell.appendChild(wrap);
  row.appendChild(cell);
  return row;
}

// ====================================================================
// CHUNK 5 — STAFF ACTIONS (per status)
// ----------------------------------------------------------------
// Every action confirms first (in-app dialog, not window.confirm),
// then writes directly to Firestore. No customer push notification
// fires from here — see the CHUNK 0 note.
// ====================================================================
function buildActionsForOrder(order) {
  const wrap = document.createElement("div");
  wrap.className = "orders-table__action-group";

  if (order.status === "pending") {
    wrap.appendChild(buildActionButton("Approve", "btn-primary", () => handleApprove(order)));
    wrap.appendChild(buildActionButton("Reject", "btn-danger-outline", () => handleReject(order)));
  } else if (order.status === "approved") {
    wrap.appendChild(buildActionButton("Mark On the Way", "btn-outline", () => handleMarkOnTheWay(order)));
  } else if (order.status === "on_the_way" && !order.awaitingCustomerConfirmation) {
    wrap.appendChild(buildActionButton("Mark Delivered", "btn-primary", () => handleMarkDelivered(order)));
    wrap.appendChild(buildActionButton("Undeliverable", "btn-danger-outline", () => openUndeliverableModal(order)));
  } else if (order.status === "cancelled" && order.cancelReason) {
    // Cancelled orders have no actions left to take — this column
    // would otherwise sit empty, so the customer's own cancellation
    // reason goes here instead, visible immediately without needing
    // to expand the row.
    const reasonNote = document.createElement("span");
    reasonNote.className = "orders-table__cancel-reason";
    reasonNote.textContent = order.cancelReason;
    wrap.appendChild(reasonNote);
  }
  // delivered / rejected / undelivered / awaiting-confirmation: no actions, view-only.

  return wrap;
}

function buildActionButton(label, className, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return btn;
}

async function handleApprove(order) {
  const confirmed = await confirmDialog(
    `Approve order #${shortOrderId(order.id)} from ${order.customerName || "this customer"}?`,
    { title: "Approve order?", confirmLabel: "Approve" }
  );
  if (!confirmed) return;

  await updateDoc(doc(db, ORDERS_COLLECTION, order.id), { status: "approved" });
  sendOrderNotification(order, "Order Approved", `Your order #${shortOrderId(order.id)} has been approved!`);
  await reloadAfterAction();
}

async function handleReject(order) {
  const confirmed = await confirmDialog(
    `Reject order #${shortOrderId(order.id)} from ${order.customerName || "this customer"}? This can't be undone.`,
    { title: "Reject order?", confirmLabel: "Reject", danger: true }
  );
  if (!confirmed) return;

  await updateDoc(doc(db, ORDERS_COLLECTION, order.id), { status: "rejected" });
  sendOrderNotification(order, "Order Rejected", `Your order #${shortOrderId(order.id)} was rejected.`);
  await reloadAfterAction();
}

async function handleMarkOnTheWay(order) {
  const confirmed = await confirmDialog(
    `Mark order #${shortOrderId(order.id)} as on the way?`,
    { title: "Mark on the way?", confirmLabel: "Confirm" }
  );
  if (!confirmed) return;

  await updateDoc(doc(db, ORDERS_COLLECTION, order.id), {
    status: "on_the_way",
    awaitingCustomerConfirmation: false
  });
  sendOrderNotification(order, "Order On The Way", `Your order #${shortOrderId(order.id)} is on its way!`);
  await reloadAfterAction();
}

// Matches the mobile app's exact two-step flow: this does NOT set
// status to "delivered" directly. It flags the order as awaiting the
// customer's confirmation (or auto-confirms after a 10-minute window
// via the mobile app's own logic) — same as _markDelivered in main.dart.
async function handleMarkDelivered(order) {
  const isPaid = await confirmDialog(
    "Confirm whether the customer has paid for this order.",
    { title: "Is the delivery paid?", confirmLabel: "Yes, Paid" }
  );
  if (!isPaid) return;

  const confirmDeadline = new Date(Date.now() + 10 * 60 * 1000);
  await updateDoc(doc(db, ORDERS_COLLECTION, order.id), {
    awaitingCustomerConfirmation: true,
    isPaid: true,
    confirmDeadline
  });
  sendOrderNotification(order, "Order Delivered", `Your order #${shortOrderId(order.id)} has been delivered — please confirm receipt in the app.`);
  await reloadAfterAction();
}

// ====================================================================
// CHUNK 6 — MARK UNDELIVERABLE (needs a reason, so it's its own modal
// rather than a simple confirm)
// ====================================================================
function openUndeliverableModal(order) {
  pendingUndeliverableOrderId = order.id;
  document.getElementById("undeliverable-reason").value = "";
  document.getElementById("undeliverable-status").hidden = true;
  document.getElementById("undeliverable-modal-overlay").hidden = false;
}

function closeUndeliverableModal() {
  document.getElementById("undeliverable-modal-overlay").hidden = true;
  pendingUndeliverableOrderId = null;
}

function wireUndeliverableModal() {
  document.getElementById("undeliverable-modal-close").addEventListener("click", closeUndeliverableModal);
  document.getElementById("undeliverable-cancel").addEventListener("click", closeUndeliverableModal);
  document.getElementById("undeliverable-confirm").addEventListener("click", handleConfirmUndeliverable);
}

async function handleConfirmUndeliverable() {
  const reason = document.getElementById("undeliverable-reason").value.trim();
  const statusEl = document.getElementById("undeliverable-status");

  if (!reason) {
    statusEl.textContent = "Please enter a reason.";
    statusEl.dataset.kind = "error";
    statusEl.hidden = false;
    return;
  }

  const confirmBtn = document.getElementById("undeliverable-confirm");
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Saving...";

  try {
    await updateDoc(doc(db, ORDERS_COLLECTION, pendingUndeliverableOrderId), {
      status: "undelivered",
      deliveryIssueReason: reason,
      awaitingCustomerConfirmation: false
    });
    const affectedOrder = allOrders.find((o) => o.id === pendingUndeliverableOrderId);
    if (affectedOrder) {
      sendOrderNotification(affectedOrder, "Delivery Issue", `There was a delivery issue with your order #${shortOrderId(affectedOrder.id)}: ${reason}`);
    }
    closeUndeliverableModal();
    await reloadAfterAction();
  } catch (error) {
    console.error("Couldn't mark order undeliverable:", error);
    statusEl.textContent = "Something went wrong. Please try again.";
    statusEl.dataset.kind = "error";
    statusEl.hidden = false;
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Confirm";
  }
}