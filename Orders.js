import { db, auth } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, setDoc, deleteDoc, updateDoc, onSnapshot, query, where, Timestamp, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { confirmDialog } from "./ConfirmDialog.js";
import { renderPager, pageSlice, clampPage } from "./Pager.js?v=20261030a";
import { restockOrder, restockUndelivered } from "./SupabaseStore.js?v=20261030i";

// ====================================================================
// CHUNK 0 — CONFIG
// ----------------------------------------------------------------
// Schema confirmed directly from your mobile app's main.dart, not
// guessed: orders/{orderId} has userId, customerName, customerAddress,
// total, itemCount, items[] ({productId, productName, imageUrl,
// flavor, amount, unitPrice, subtotal}), status, createdAt,
// estimatedDelivery, and (once marked delivered) isPaid. There is no
// customer "Confirm Received" step any more: Delivered is final.
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
  ready_for_pickup: ["ready_for_pickup"],
  on_the_way: ["on_the_way"],
  delivered: ["delivered"],
  cancelled: ["cancelled", "rejected"],
  undelivered: ["undelivered"]
};

const STATUS_META = {
  pending: { label: "Pending", badgeClass: "order-badge--pending" },
  approved: { label: "Approved", badgeClass: "order-badge--approved" },
  ready_for_pickup: { label: "Ready for Pickup", badgeClass: "order-badge--ready" },
  on_the_way: { label: "On the Way", badgeClass: "order-badge--on-the-way" },
  delivered: { label: "Delivered", badgeClass: "order-badge--delivered" },
  cancelled: { label: "Cancelled", badgeClass: "order-badge--cancelled" },
  rejected: { label: "Rejected", badgeClass: "order-badge--cancelled" },
  undelivered: { label: "Unable to Deliver", badgeClass: "order-badge--cancelled" }
};

let allOrders = [];
let searchQuery = "";
let sortOrder = "newest"; // "newest" | "oldest"
let fulfillmentFilter = "all"; // "all" | "pickup" | "delivery"
let groupBy = "none"; // "none" | "week" | "month" | "year"
let expandedGroupLabel; // undefined = never set yet (auto-expand first group); null = user deliberately collapsed everything (stay collapsed); a string = that specific group is open
let activeTab = "all";
let ordersPage = 1;
let ordersPerPage = 50;
let ordersFilterSig = "";
let cancelledSubStatus = "cancelled"; // when activeTab === "cancelled": "cancelled" or "rejected"
let expandedOrderDetail = null;   // accordion: only one order's detail row open at a time
let expandedOrderMainRow = null;
let currentRole = "employee";
let currentIsDriver = false; // drivers only get the delivery buttons
let pendingUndeliverableOrderId = null;

// ====================================================================
// CHUNK 1 — WAIT FOR THE SHARED SIDEBAR (auth guard lives there)
// ====================================================================
let targetOrderId = new URLSearchParams(window.location.search).get("orderId");
let hasHandledTargetOrder = false;

document.addEventListener("sidebar:ready", (event) => {
  currentRole = event.detail.role;
  currentIsDriver = Boolean(event.detail.isDriver);

  wireTabs();
  wireSearch();
  wireSort();
  wireUndeliverableModal();
  wireRejectModal();
  document.getElementById("orders-show-older-btn").addEventListener("click", toggleFullHistory);
  updateShowOlderButton();
  loadOrders();
});

// ====================================================================
// CHUNK 2 — LOAD ORDERS
// ====================================================================
// Recent-only by default — an order history that grows forever would
// otherwise mean this page gets slower every month, with no ceiling.
// "Show older orders" switches to the full, unfiltered query on
// demand, so anyone tracking down an old order can still find it —
// it's just not downloaded automatically on every single page visit.
const RECENT_WINDOW_DAYS = 7;
const DRIVER_RECENT_DAYS = 2;
// An order still "in progress" after this long is almost certainly leftover
// (test data, or one nobody closed). It is hidden by default and still
// reachable with "Show older orders".
const STUCK_ORDER_DAYS = 30;
// Orders that still need someone to act, whatever their age: they are always
// loaded, so a stuck order older than the window never disappears.
const ACTIVE_STATUSES = ["pending", "approved", "ready_for_pickup", "on_the_way"];
let showingFullHistory = false;
let hiddenUnfinishedCount = 0;
let orderUnsubs = [];
const orderParts = new Map(); // listener name -> Map(orderId -> order)
let mergeTimer = null;

function daysAgoTimestamp(days) {
  return Timestamp.fromDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
}

// Each listener fills its own bucket; the page shows the union of the buckets.
function watchOrders(name, q, isMain) {
  orderParts.set(name, new Map());
  const unsub = onSnapshot(
    q,
    (snap) => {
      const part = new Map();
      snap.docs.forEach((docSnap) => part.set(docSnap.id, { id: docSnap.id, ...docSnap.data() }));
      orderParts.set(name, part);
      scheduleMerge();
    },
    (error) => {
      console.error(`Couldn't load orders (${name}):`, error);
      if (isMain) {
        document.getElementById("orders-tbody").innerHTML =
          `<tr><td colspan="7" class="inventory-empty">Couldn't load orders right now.</td></tr>`;
      }
    }
  );
  orderUnsubs.push(unsub);
}

// Several listeners can answer within the same moment (first load): draw once.
function scheduleMerge() {
  if (mergeTimer) return;
  mergeTimer = setTimeout(() => {
    mergeTimer = null;
    const byId = new Map();
    let hiddenUnfinished = 0;
    const now = Date.now();
    const recentCutoff = now - (currentIsDriver ? DRIVER_RECENT_DAYS : RECENT_WINDOW_DAYS) * 86400000;
    orderParts.forEach((part) => part.forEach((order, id) => {
      if (!showingFullHistory) {
        const ts = order.createdAt?.toMillis?.() || 0;
        const keep = !ts || ts >= recentCutoff;
        if (!keep) {
          // Older than the window: hidden, but counted if it was never finished, so the button can say so.
          if (ACTIVE_STATUSES.includes(order.status)) hiddenUnfinished += 1;
          return;
        }
      }
      byId.set(id, order);
    }));
    hiddenUnfinishedCount = hiddenUnfinished;
    updateShowOlderButton();
    allOrders = [...byId.values()].sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    updateCounts();
    render();
    document.dispatchEvent(new Event("orders:changed")); // lets the sidebar badge refresh its count
  }, 60);
}

function loadOrders() {
  orderUnsubs.forEach((u) => u());
  orderUnsubs = [];
  orderParts.clear();
  const ordersRef = collection(db, ORDERS_COLLECTION);

  // Real-time, like before: a staff action here or a customer-side change
  // from the mobile app shows up without reloading. What changed is how much
  // is downloaded: only recent orders plus the ones still in progress, and
  // drivers get just their own deliveries.
  if (currentIsDriver) {
    watchOrders("active", query(ordersRef, where("status", "in", ["approved", "on_the_way"])), true);
    const uid = auth.currentUser?.uid;
    if (uid) {
      // Needs a composite index (driverUid + createdAt). If it is missing the
      // driver still sees their open deliveries; only their finished ones drop off.
      watchOrders("mine", query(ordersRef, where("driverUid", "==", uid), where("createdAt", ">=", daysAgoTimestamp(DRIVER_RECENT_DAYS))), false);
    }
    return;
  }

  if (showingFullHistory) {
    watchOrders("all", ordersRef, true);
  } else {
    watchOrders("recent", query(ordersRef, where("createdAt", ">=", daysAgoTimestamp(RECENT_WINDOW_DAYS))), true);
    watchOrders("active", query(ordersRef, where("status", "in", ACTIVE_STATUSES)), false);
  }
}

function toggleFullHistory() {
  showingFullHistory = !showingFullHistory;
  loadOrders();
  updateShowOlderButton();
}

function updateShowOlderButton() {
  const btn = document.getElementById("orders-show-older-btn");
  if (!btn) return;
  btn.hidden = currentIsDriver; // drivers only ever see their own deliveries
  btn.textContent = showingFullHistory
    ? "Showing all orders — click to show recent only"
    : `Show older orders (beyond the last ${RECENT_WINDOW_DAYS} days)${hiddenUnfinishedCount ? ` \u2014 ${hiddenUnfinishedCount} older order${hiddenUnfinishedCount === 1 ? " is" : "s are"} still unfinished` : ""}`;
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

  if (fulfillmentFilter !== "all") {
    orders = orders.filter((o) => (isPickupOrder(o) ? "pickup" : "delivery") === fulfillmentFilter);
  }

  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    orders = orders.filter((order) => {
      const idMatch = shortOrderId(order.id).toLowerCase().includes(q);
      const nameMatch = (order.customerName || "").toLowerCase().includes(q);
      const dateMatch = formatOrderDate(order).toLowerCase().includes(q);
      const branchMatch = isPickupOrder(order) && pickupBranchName(order).toLowerCase().includes(q);
      return idMatch || nameMatch || dateMatch || branchMatch;
    });
  }

  return [...orders].sort((a, b) => {
    const aMillis = a.createdAt?.toMillis?.() || 0;
    const bMillis = b.createdAt?.toMillis?.() || 0;
    return sortOrder === "newest" ? bMillis - aMillis : aMillis - bMillis;
  });
}

function buildGroupHeaderRow(label, isExpanded) {
  const row = document.createElement("tr");
  row.className = "orders-group-header-row";
  row.dataset.groupLabel = label;
  row.innerHTML = `
    <td colspan="7">
      <span class="orders-group-header-row__chevron">${isExpanded ? "▾" : "▸"}</span>
      ${label}
    </td>
  `;
  row.addEventListener("click", () => {
    // True accordion — only one group open at a time, matching "click
    // September, only September shows" rather than independently
    // toggleable sections.
    expandedGroupLabel = expandedGroupLabel === label ? null : label;
    render();
  });
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
  const fulfillmentSelect = document.getElementById("orders-fulfillment-select");
  if (fulfillmentSelect) {
    fulfillmentSelect.addEventListener("change", (event) => {
      fulfillmentFilter = event.target.value;
      render();
    });
  }
  document.getElementById("orders-group-select").addEventListener("change", (event) => {
    groupBy = event.target.value;
    expandedGroupLabel = undefined; // let render() auto-pick the first group under the new scheme
    render();
  });
}

// ====================================================================
// CHUNK 4 — RENDER TABLE
// ====================================================================
function render() {
  document.getElementById("cancelled-subtabs").hidden = activeTab !== "cancelled";
  loadRiderNames(); // real rider names; redraws once if any arrive
  startRiderLocationListener(); // live rider pins (follows the visible orders)
  syncRiderSharing(); // riders: start/stop sharing their location for their deliveries

  // Remember which order was expanded before rebuilding the table, so
  // a live update elsewhere doesn't silently collapse whatever the
  // admin is currently looking at.
  const previouslyExpandedOrderId = expandedOrderMainRow?.dataset.orderId || null;
  expandedOrderDetail = null;
  expandedOrderMainRow = null;

  const tbody = document.getElementById("orders-tbody");
  const allMatching = ordersForActiveTab();

  // A different tab, search, sort, filter or grouping starts again at page 1.
  const sig = [activeTab, searchQuery, sortOrder, fulfillmentFilter, groupBy, document.querySelector("#cancelled-subtabs .is-active")?.dataset?.substatus || ""].join("|");
  if (sig !== ordersFilterSig) { ordersFilterSig = sig; ordersPage = 1; }
  ordersPage = clampPage(ordersPage, allMatching.length, ordersPerPage);
  const orders = pageSlice(allMatching, ordersPage, ordersPerPage);
  renderPager(document.getElementById("orders-pager"), {
    total: allMatching.length, page: ordersPage, perPage: ordersPerPage,
    onPage: (n) => { ordersPage = n; render(); },
    onSize: (n) => { ordersPerPage = n; ordersPage = 1; render(); }
  });

  if (orders.length === 0) {
    const message = searchQuery.trim() ? "No orders match your search." : "No orders here.";
    tbody.innerHTML = `<tr><td colspan="7" class="inventory-empty">${message}</td></tr>`;
    return;
  }

  tbody.innerHTML = "";
  let lastGroupLabel = undefined; // undefined (not null) so the very first order always triggers a header when grouping is on
  orders.forEach((order) => {
    let currentGroupLabel = null;
    if (groupBy !== "none") {
      currentGroupLabel = getGroupLabel(order);
      if (currentGroupLabel !== lastGroupLabel) {
        // Nothing expanded yet (grouping was just turned on, or this
        // is the first render since) — default to opening the first
        // group encountered, rather than starting with everything
        // collapsed and nothing visible at all.
        if (expandedGroupLabel === undefined) expandedGroupLabel = currentGroupLabel;
        tbody.appendChild(buildGroupHeaderRow(currentGroupLabel, currentGroupLabel === expandedGroupLabel));
        lastGroupLabel = currentGroupLabel;
      }
    }

    const isGroupCollapsed = groupBy !== "none" && currentGroupLabel !== expandedGroupLabel;

    const mainRow = buildOrderRow(order);
    mainRow.dataset.orderId = order.id;
    mainRow.hidden = isGroupCollapsed;
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
      startRiderLocationListener(); // start/stop watching this rider with the open details
    });

    if (order.id === previouslyExpandedOrderId) {
      detailRow.hidden = false;
      mainRow.classList.add("is-expanded");
      expandedOrderDetail = detailRow;
      expandedOrderMainRow = mainRow;
    }
  });

  handleTargetOrderJump();
  startRiderLocationListener(); // now that the open row is known
}

// Arrived here from a notification click ("New order from Elde —
// ₱855.00") — jump straight to that specific order: switch to the
// "All" tab (guarantees it's actually in the rendered table
// regardless of its current status), scroll it into view, expand its
// detail, and highlight it. Runs once, not on every subsequent
// real-time re-render.
function handleTargetOrderJump() {
  if (!targetOrderId || hasHandledTargetOrder) return;

  if (activeTab !== "all") {
    hasHandledTargetOrder = true; // set before switching tabs — switching triggers another render()
    activeTab = "all";
    document.querySelectorAll(".order-status-card").forEach((card) =>
      card.classList.toggle("is-active", card.dataset.status === "all")
    );
    render();
    return;
  }

  const targetRow = document.querySelector(`tr[data-order-id="${targetOrderId}"]`);
  if (!targetRow) {
    // It may simply be on another page of the list.
    const idx = ordersForActiveTab().findIndex((o) => o.id === targetOrderId);
    if (idx >= 0) {
      const wanted = Math.floor(idx / ordersPerPage) + 1;
      if (wanted !== ordersPage) { ordersPage = wanted; render(); return; }
    }
    if (!showingFullHistory && !currentIsDriver) {
      // Not found yet, but might just be older than the recent
      // window — expand to full history and let the next render
      // retry, rather than assuming it's genuinely missing.
      showingFullHistory = true;
      updateShowOlderButton();
      loadOrders();
      return;
    }
    // Genuinely isn't in the list even with full history (deleted,
    // or the ID was stale) — stop trying rather than retrying forever.
    hasHandledTargetOrder = true;
    targetOrderId = null;
    return;
  }

  // If grouping is active and this order's group is currently
  // collapsed, its row exists in the DOM but is hidden — expand that
  // specific group first, then let the next render's pass find it
  // visible and proceed normally.
  if (targetRow.hidden && groupBy !== "none") {
    const targetOrder = allOrders.find((o) => o.id === targetOrderId);
    if (targetOrder) {
      expandedGroupLabel = getGroupLabel(targetOrder);
      render();
      return;
    }
  }

  hasHandledTargetOrder = true;
  targetRow.click(); // reuses the existing expand/accordion logic already wired on this row
  targetRow.classList.add("is-highlighted-from-notification");
  targetRow.scrollIntoView({ behavior: "smooth", block: "center" });

  // Clean the query param so refreshing the page doesn't repeat this.
  if (window.history.replaceState) {
    window.history.replaceState({}, "", window.location.pathname);
  }

  setTimeout(() => targetRow.classList.remove("is-highlighted-from-notification"), 3000);
}

// Orders from before "Pick Up In Store" have no fulfillmentType at all —
// those are deliveries. Pickup orders also skip the delivery-only fields
// (map pin, distance, delivery branch), so nothing below may assume those exist.
function isPickupOrder(order) {
  return order.fulfillmentType === "pickup";
}

function pickupBranchName(order) {
  return typeof order.pickupBranch === "string" ? order.pickupBranch.trim() : "";
}

function shortOrderId(id) {
  return id.slice(0, 8).toUpperCase();
}

// Only http(s) links are ever used for the "View on map" button.
function safeMapUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

// ====================================================================
// DELIVERY ADDRESS MAP
// ----------------------------------------------------------------
// Orders only store a plain text address (whatever the customer
// typed or picked from their saved addresses in the mobile app,
// landmarks included as free text) — no actual coordinates. So this
// works by ADDRESS SEARCH, not by plotting a known exact point;
// accuracy depends on how specific/well-formed the customer's typed
// address (and any landmark mentioned in it) actually is.
//
// Uses Google's plain address-search embed URL, which — unlike the
// official Maps Embed API — doesn't require an API key or any setup.
// HONEST NOTE: this is a long-standing but technically unofficial
// pattern; Google could change it without notice. The "Open in
// Google Maps" link below is a reliable fallback either way, and
// works the exact same way regardless.
// ====================================================================
// Reads a saved coordinate (number, or numeric string) and checks its range.
function toCoord(value, limit) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

function buildAddressMap(order) {
  const wrap = document.createElement("div");
  wrap.className = "order-detail__map-wrap";

  // Exact pin first: the customer app saves deliveryLat/deliveryLng, so the
  // embedded map is centred on (and marks) those coordinates directly. The
  // typed address is only searched when no coordinates were saved (older
  // orders, or addresses that were never re-pinned).
  const lat = toCoord(order.deliveryLat, 90);
  const lng = toCoord(order.deliveryLng, 180);
  const hasCoords = lat !== null && lng !== null;
  const encoded = encodeURIComponent(hasCoords ? `${lat},${lng}` : order.customerAddress);

  const iframe = document.createElement("iframe");
  iframe.className = "order-detail__map";
  iframe.src = `https://maps.google.com/maps?q=${encoded}&output=embed`;
  iframe.loading = "lazy";
  iframe.referrerPolicy = "no-referrer-when-downgrade";
  iframe.title = "Delivery location map";
  wrap.appendChild(iframe);

  // Link below the map: the customer's own pin link when present, otherwise
  // a Google Maps link built from the coordinates, otherwise from the text.
  const pinUrl = safeMapUrl(order.deliveryMapUrl);
  const link = document.createElement("a");
  link.href = pinUrl || `https://www.google.com/maps/search/?api=1&query=${encoded}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.className = "order-detail__map-link";
  link.textContent = pinUrl ? "Open pinned location ↗" : "Open in Google Maps ↗";
  wrap.appendChild(link);

  return wrap;
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
    // The Worker only accepts order pushes from signed-in staff.
    const idToken = await auth.currentUser?.getIdToken();
    const response = await fetch(NOTIFICATION_WORKER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(idToken ? { "Authorization": `Bearer ${idToken}` } : {})
      },
      body: JSON.stringify({ targetUid: order.userId, orderId: order.id, title, message })
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

// "Pickup · Main Branch" pill shown in the list and in the order details.
function buildPickupTag(order) {
  const tag = document.createElement("span");
  tag.className = "order-tag order-tag--pickup";
  const branch = pickupBranchName(order);
  tag.textContent = branch ? `Pickup · ${branch}` : "Pickup";
  return tag;
}

function formatPeso(value) {
  return typeof value === "number" && Number.isFinite(value) ? `₱${value.toFixed(2)}` : null;
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
  if (isPickupOrder(order)) {
    const tag = buildPickupTag(order);
    cells[1].appendChild(document.createElement("br"));
    cells[1].appendChild(tag);
  }
  cells[2].textContent = itemsSummary;
  cells[3].textContent = typeof order.total === "number" ? `₱${order.total.toFixed(2)}` : "—";
  cells[4].textContent = formatOrderDate(order);

  const badge = document.createElement("span");
  badge.className = `order-badge ${meta.badgeClass}`;
  // A finished pickup order reads "Picked Up" rather than "Delivered".
  badge.textContent = isPickupOrder(order) && order.status === "delivered" ? "Picked Up" : meta.label;
  cells[5].appendChild(badge);
  // Which driver account handled it (set when they mark it on the way).
  if (!isPickupOrder(order) && riderLabel(order) && ["on_the_way", "delivered", "undelivered"].includes(order.status)) {
    const by = document.createElement("div");
    by.className = "order-handled-by";
    by.textContent = `Rider: ${riderLabel(order)}`;
    cells[5].appendChild(by);
  }

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

  const pickup = isPickupOrder(order);

  if (pickup) {
    // Store pickup: no address, pin or map. (customerAddress may be empty or
    // stale on these orders, so it is deliberately not shown.)
    const pickupLine = document.createElement("p");
    pickupLine.className = "order-detail__address";
    const pickupText = document.createElement("span");
    pickupText.className = "order-detail__address-text";
    const label = document.createElement("strong");
    label.textContent = "Pick up at: ";
    const branch = pickupBranchName(order);
    pickupText.append(label, branch || "Store");
    pickupLine.appendChild(pickupText);
    pickupLine.appendChild(buildPickupTag(order));
    wrap.appendChild(pickupLine);

    const na = document.createElement("p");
    na.className = "order-detail__meta";
    na.textContent = "Delivery address and map: N/A — Store Pickup. No delivery fee.";
    wrap.appendChild(na);
  } else {
    const addressLine = document.createElement("p");
    addressLine.className = "order-detail__address";
    const addressText = document.createElement("span");
    addressText.className = "order-detail__address-text";
    if (order.customerAddress) {
      const label = document.createElement("strong");
      label.textContent = "Deliver to: ";
      addressText.append(label, order.customerAddress);
    } else {
      addressText.textContent = "No address on file.";
    }
    addressLine.appendChild(addressText);

    // Exact pin from the customer app (only on orders where the delivery fee
    // was calculated). Hidden entirely when missing or not a real web link.
    const mapUrl = safeMapUrl(order.deliveryMapUrl);
    if (mapUrl) {
      const mapLink = document.createElement("a");
      mapLink.className = "order-detail__pin-link";
      mapLink.href = mapUrl;
      mapLink.target = "_blank";
      mapLink.rel = "noopener noreferrer";
      mapLink.textContent = "View on map ↗";
      addressLine.appendChild(mapLink);
    }
    wrap.appendChild(addressLine);

    // Delivery details — each part only when the order actually has it.
    const parts = [];
    const fee = formatPeso(order.deliveryFee);
    if (fee) parts.push(`Delivery fee: ${fee}`);
    if (typeof order.deliveryDistanceKm === "number" && Number.isFinite(order.deliveryDistanceKm)) {
      parts.push(`Distance: ${order.deliveryDistanceKm.toFixed(1)} km`);
    }
    if (typeof order.deliveryBranch === "string" && order.deliveryBranch.trim()) {
      parts.push(`From: ${order.deliveryBranch.trim()}`);
    }
    if (order.deliveryFeeUnresolved === true) parts.push("Delivery fee not calculated");

    if (parts.length > 0) {
      const meta = document.createElement("p");
      meta.className = "order-detail__meta";
      meta.textContent = parts.join(" · ");
      wrap.appendChild(meta);
    }

    // Rider: the person who tapped "Mark On the Way".
    const rider = riderLabel(order);
    if (rider || ["approved", "on_the_way"].includes(order.status)) {
      const riderLine = document.createElement("p");
      riderLine.className = "order-detail__rider";
      const riderTitle = document.createElement("span");
      riderTitle.textContent = "Rider: ";
      const riderName = document.createElement("strong");
      riderName.textContent = rider || "not on the way yet";
      if (!rider) riderName.className = "order-detail__rider--none";
      riderLine.append(riderTitle, riderName);
      wrap.appendChild(riderLine);
    }

    const track = buildRiderTrack(order);
    if (track) wrap.appendChild(track);

    if (order.customerAddress || (toCoord(order.deliveryLat, 90) !== null && toCoord(order.deliveryLng, 180) !== null)) {
      wrap.appendChild(buildAddressMap(order));
    }
  }

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

  if (order.rejectReason) {
    const rejectLine = document.createElement("p");
    rejectLine.className = "order-detail__reason";
    rejectLine.textContent = `Rejected: ${order.rejectReason}`;
    wrap.appendChild(rejectLine);
  }

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

  // Who can do what:
  //   Admin             approve / reject only
  //   Driver            delivery steps only (on the way, delivered, undeliverable)
  //   Regular employee  view only — no order actions at all
  const isAdminUser = currentRole === "admin";
  // Pickup orders have their own steps, and only the admin runs them:
  //   approved -> "Mark Ready for Pickup" (customer gets a push)
  //   ready_for_pickup -> "Mark Picked Up" (completes the order, marks it paid)
  // They never use the driver's delivery steps.
  if (isPickupOrder(order) && ["approved", "ready_for_pickup", "on_the_way"].includes(order.status)) {
    if (!isAdminUser) {
      if (!currentIsDriver) {
        const note = document.createElement("span");
        note.className = "orders-table__view-only";
        note.textContent = "View only";
        wrap.appendChild(note);
      }
      return wrap;
    }
    if (order.status === "approved") {
      wrap.appendChild(buildActionButton("Mark Ready for Pickup", "btn-primary", () => handleMarkReadyForPickup(order)));
    } else if (order.status === "ready_for_pickup") {
      wrap.appendChild(buildActionButton("Mark Picked Up", "btn-primary", () => handleMarkPickedUp(order)));
    } else {
      const note = document.createElement("span");
      note.className = "orders-table__view-only";
      note.textContent = "Store pickup";
      wrap.appendChild(note);
    }
    return wrap;
  }
  const actionable = ["pending", "approved", "on_the_way"].includes(order.status);
  const allowed = order.status === "pending" ? isAdminUser : currentIsDriver;

  if (actionable && !allowed) {
    // Nothing to click for this person. Drivers see a blank cell on pending
    // orders (the admin approves first); everyone else gets a small note.
    if (!currentIsDriver) {
      const note = document.createElement("span");
      note.className = "orders-table__view-only";
      note.textContent = isAdminUser ? "Driver handles delivery" : "View only";
      wrap.appendChild(note);
    }
    return wrap;
  }

  if (order.status === "pending") {
    wrap.appendChild(buildActionButton("Approve", "btn-primary", () => handleApprove(order)));
    wrap.appendChild(buildActionButton("Reject", "btn-danger-outline", () => handleReject(order)));
  } else if (order.status === "approved") {
    wrap.appendChild(buildActionButton("Mark On the Way", "btn-outline btn-on-the-way", () => handleMarkOnTheWay(order)));
  } else if (order.status === "on_the_way") {
    wrap.appendChild(buildActionButton("Mark Delivered", "btn-primary", () => handleMarkDelivered(order)));
    wrap.appendChild(buildActionButton("Undeliverable", "btn-danger-outline", () => openUndeliverableModal(order)));
  } else if (order.status === "rejected" && order.rejectReason) {
    const rejectNote = document.createElement("span");
    rejectNote.className = "orders-table__cancel-reason";
    rejectNote.textContent = order.rejectReason;
    wrap.appendChild(rejectNote);
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
  // delivered / rejected / undelivered: no actions, view-only.

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


// ---- Ready-made reasons (with "Other" for anything else) ----
const REJECT_REASONS = [
  "Item is out of stock",
  "Item is no longer available",
  "Outside our delivery area",
  "Incomplete or incorrect address",
  "Unable to contact the customer",
  "Duplicate order",
  "Store is closed or cannot deliver today"
];
const UNDELIVERABLE_REASONS = [
  "Customer not available",
  "Customer not answering calls or messages",
  "Wrong or incomplete address",
  "Could not find the address",
  "Customer refused the order",
  "Customer asked to cancel",
  "Unsafe or unreachable location",
  "Vehicle problem or bad weather"
];
const OTHER_REASON = "Others (please specify)";

function setupReasonPicker(selectId, textId, reasons) {
  const select = document.getElementById(selectId);
  const text = document.getElementById(textId);
  select.replaceChildren(...[...reasons, OTHER_REASON].map((r) => {
    const o = document.createElement("option");
    o.value = r === OTHER_REASON ? "__other__" : r;
    o.textContent = r;
    return o;
  }));
  const sync = () => { text.hidden = select.value !== "__other__"; if (!text.hidden) text.focus(); };
  select.addEventListener("change", sync);
}
function resetReasonPicker(selectId, textId) {
  const select = document.getElementById(selectId);
  select.selectedIndex = 0;
  const text = document.getElementById(textId);
  text.value = "";
  text.hidden = select.value !== "__other__";
}
function readReason(selectId, textId) {
  const select = document.getElementById(selectId);
  return select.value === "__other__" ? document.getElementById(textId).value.trim() : select.value;
}

// Rejecting needs a reason (the customer is told why), so it has its own modal.
let pendingRejectOrderId = null;

function handleReject(order) {
  pendingRejectOrderId = order.id;
  document.getElementById("reject-order-label").textContent =
    `Order #${shortOrderId(order.id)} from ${order.customerName || "this customer"}. This can't be undone.`;
  resetReasonPicker("reject-reason-select", "reject-reason");
  document.getElementById("reject-status").hidden = true;
  document.getElementById("reject-modal-overlay").hidden = false;
}

function closeRejectModal() {
  document.getElementById("reject-modal-overlay").hidden = true;
  pendingRejectOrderId = null;
}

function wireRejectModal() {
  document.getElementById("reject-modal-close").addEventListener("click", closeRejectModal);
  document.getElementById("reject-cancel").addEventListener("click", closeRejectModal);
  document.getElementById("reject-confirm").addEventListener("click", handleConfirmReject);
}

async function handleConfirmReject() {
  const statusEl = document.getElementById("reject-status");
  const reason = readReason("reject-reason-select", "reject-reason");
  if (!reason) {
    statusEl.textContent = "Please enter a reason.";
    statusEl.dataset.kind = "error";
    statusEl.hidden = false;
    return;
  }
  const order = allOrders.find((o) => o.id === pendingRejectOrderId);
  if (!order) { closeRejectModal(); return; }

  const confirmBtn = document.getElementById("reject-confirm");
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Rejecting...";
  let stockNote = "";
  try {
    await updateDoc(doc(db, ORDERS_COLLECTION, order.id), { status: "rejected", rejectReason: reason });
    sendOrderNotification(order, "Order Rejected", `Your order #${shortOrderId(order.id)} was rejected. Reason: ${reason}`);

    // The customer app took these items out of stock when the order was placed;
    // a rejected order gives them back (once). A failure here never blocks the rejection.
    if (order.userId) {
      try {
        await restockOrder(order.userId, order.id);
      } catch (error) {
        if (error.code !== "nothing_to_restock") {
          console.error("Couldn't return the stock for a rejected order:", error);
          stockNote = "The order was rejected, but its items could not be returned to stock automatically. Please check the stock for this order.";
        }
      }
    }
    closeRejectModal();
    await reloadAfterAction();
  } catch (error) {
    console.error("Couldn't reject order:", error);
    statusEl.textContent = "Something went wrong. Please try again.";
    statusEl.dataset.kind = "error";
    statusEl.hidden = false;
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Reject order";
  }
  if (stockNote) await confirmDialog(stockNote, { title: "Stock not returned", confirmLabel: "OK" });
}

// Records WHICH driver account handled the delivery, so the admin can see
// who it was. The driver's own sign-in is the record (the rules require the
// uid/email to match the person writing it, so it can't be faked).
// The employee profile keeps the real name in "firstName" (what the greeting uses).
function profileName(snap) {
  if (!snap.exists()) return "";
  const data = snap.data();
  const value = [data.firstName, data.name].find((v) => typeof v === "string" && v.trim());
  return value ? value.trim() : "";
}

async function currentDriverStamp() {
  const user = auth.currentUser;
  if (!user) return {};
  // The real name lives on the employee profile (the same one the greeting
  // uses). The sign-in's own display name can be a username, so it is only
  // the fallback.
  let name = "";
  try {
    const snap = await getDoc(doc(db, "employees", user.uid));
    name = profileName(snap);
  } catch (error) {
    console.error("Couldn't read the rider's profile name:", error);
  }
  return {
    driverUid: user.uid,
    driverEmail: user.email || "",
    driverName: (name || user.displayName || "").trim().slice(0, 60)
  };
}


// ====================================================================
// RIDER LOCATION
// ----------------------------------------------------------------
// Two things, both written by the rider's own phone:
//  1) Snapshots saved on the order — where the rider was when they tapped
//     "On the Way" (onTheWayLocation) and when they finished the delivery
//     (deliveredLocation). Works every time, no background tracking needed.
//  2) Live location while a delivery is on the way (driverLocations/{orderId}),
//     sent every ~30 s. A website can only do this while the page is open and
//     the screen is on — browsers pause it in the background — so the admin
//     sees "Updated … ago" and a warning when the pin stops moving.
// ====================================================================
const LOCATIONS_COLLECTION = "driverLocations";
const SHARE_INTERVAL_MS = 30000; // each location update is a database write, and every open viewer reads it
const STALE_AFTER_MS = 2 * 60 * 1000;
let locationWarmedUp = false;
const riderLocations = new Map(); // orderId -> live location doc (admin/staff side)

function positionToPlain(pos) {
  return {
    lat: Number(pos.coords.latitude.toFixed(6)),
    lng: Number(pos.coords.longitude.toFixed(6)),
    accuracy: Math.round(pos.coords.accuracy || 0),
    at: Date.now()
  };
}

// One-shot reading; resolves null if the phone can't or won't share.
// A recent network/Wi-Fi fix (up to 2 minutes old) is fine for these one-off snapshots and comes back
// at once; waiting for a fresh high-accuracy GPS fix could hold up "On the way" for several seconds.
function readPosition(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(positionToPlain(pos)),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 120000 }
    );
  });
}

// Riders only: a one-off reading saved on the order. Empty if unavailable.
async function locationField(name) {
  if (!currentIsDriver) return {};
  const pos = await readPosition();
  return pos ? { [name]: pos } : {};
}

function distanceMeters(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

// ---- Rider side: share live location while a delivery is on the way ----
let geoWatchId = null;
let wakeLock = null;
let latestPos = null;
let lastWriteAt = 0;
let shareBarEl = null;
const sharedOrderIds = new Set();

// Accounts the rider has temporarily hidden their live location from. Kept for
// this browser tab only and cleared once the rider has no deliveries left.
const HIDDEN_KEY = "almares_loc_hidden";
const hiddenFromUids = new Set(readHiddenList());
let hidePanelEl = null;

function readHiddenList() {
  try { return JSON.parse(sessionStorage.getItem(HIDDEN_KEY) || "[]").filter((v) => typeof v === "string"); }
  catch (error) { return []; }
}
function saveHiddenList() {
  try {
    if (hiddenFromUids.size) sessionStorage.setItem(HIDDEN_KEY, JSON.stringify([...hiddenFromUids]));
    else sessionStorage.removeItem(HIDDEN_KEY);
  } catch (error) { /* private mode: it just won't survive a reload */ }
}

function myActiveDeliveries() {
  const uid = auth.currentUser?.uid;
  if (!uid) return [];
  return allOrders.filter((o) => o.status === "on_the_way" && !isPickupOrder(o) && o.driverUid === uid);
}

function showShareBar(message, kind) {
  if (!shareBarEl) {
    shareBarEl = document.createElement("div");
    shareBarEl.className = "rider-share-bar";
    const text = document.createElement("span");
    text.className = "rider-share-bar__text";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rider-share-bar__btn";
    btn.addEventListener("click", toggleHidePanel);
    shareBarEl.append(text, btn);
    document.body.appendChild(shareBarEl);
    document.body.classList.add("has-share-bar"); // leaves room so the bar never covers content
  }
  shareBarEl.dataset.kind = kind;
  shareBarEl.querySelector(".rider-share-bar__text").textContent = message;
  shareBarEl.querySelector(".rider-share-bar__btn").textContent =
    hiddenFromUids.size ? `Hidden from ${hiddenFromUids.size} ▾` : "Hide from… ▾";
}

// Dropdown checklist: untick/tick who may see this rider's live location.
async function toggleHidePanel() {
  if (hidePanelEl) { closeHidePanel(); return; }
  hidePanelEl = document.createElement("div");
  hidePanelEl.className = "rider-hide-panel";
  hidePanelEl.innerHTML = `
    <p class="rider-hide-panel__title">Hide my live location from:</p>
    <p class="rider-hide-panel__note">Temporary. Everyone can see you by default, and this resets after your deliveries.</p>
    <div class="rider-hide-panel__list">Loading…</div>`;
  document.body.appendChild(hidePanelEl);
  const list = hidePanelEl.querySelector(".rider-hide-panel__list");

  try {
    const [admins, employees] = await Promise.all([
      getDocs(collection(db, "admins")),
      getDocs(collection(db, "employees"))
    ]);
    const me = auth.currentUser?.uid;
    const people = [];
    admins.forEach((d) => people.push({ uid: d.id, role: "Admin", label: d.data().email || d.data().name || d.id }));
    employees.forEach((d) => {
      const data = d.data();
      if (d.id === me || data.isDriver === true || data.approved === false) return;
      people.push({ uid: d.id, role: "Employee", label: data.email || data.firstName || d.id });
    });
    if (!hidePanelEl) return;
    list.textContent = "";
    if (people.length === 0) { list.textContent = "No other accounts found."; return; }
    people.forEach((person) => {
      const row = document.createElement("label");
      row.className = "rider-hide-panel__row";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = hiddenFromUids.has(person.uid);
      box.addEventListener("change", () => {
        if (box.checked) hiddenFromUids.add(person.uid); else hiddenFromUids.delete(person.uid);
        saveHiddenList();
        showShareBar(shareBarEl.querySelector(".rider-share-bar__text").textContent, shareBarEl.dataset.kind);
        writeLiveLocations(true);
      });
      const text = document.createElement("span");
      text.textContent = `${person.label} (${person.role})`;
      row.append(box, text);
      list.appendChild(row);
    });
  } catch (error) {
    console.error("Couldn't load the account list:", error);
    list.textContent = "Couldn't load the account list.";
  }
}

function closeHidePanel() {
  if (hidePanelEl) hidePanelEl.remove();
  hidePanelEl = null;
}

function hideShareBar() {
  closeHidePanel();
  if (shareBarEl) shareBarEl.remove();
  shareBarEl = null;
  document.body.classList.remove("has-share-bar");
}

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (error) { /* not supported or refused: tracking still works while the screen is on */ }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && geoWatchId !== null) requestWakeLock();
});

function writeLiveLocations(force) {
  const uid = auth.currentUser?.uid;
  if (!uid || !latestPos) return;
  if (!force && Date.now() - lastWriteAt < SHARE_INTERVAL_MS) return;
  lastWriteAt = Date.now();
  myActiveDeliveries().forEach((order) => {
    setDoc(doc(db, LOCATIONS_COLLECTION, order.id), {
      orderId: order.id,
      driverUid: uid,
      lat: latestPos.lat,
      lng: latestPos.lng,
      accuracy: latestPos.accuracy,
      hiddenFrom: [...hiddenFromUids].slice(0, 40),
      updatedAt: serverTimestamp()
    }).catch((error) => console.error("Couldn't share location:", error));
  });
}

function startLocationWatch(count) {
  const label = `Sharing your location for ${count} deliver${count === 1 ? "y" : "ies"}. Keep this page open and the screen on.`;
  if (geoWatchId !== null) { showShareBar(label, "ok"); return; }
  if (!navigator.geolocation) {
    showShareBar("This phone can't share its location.", "warn");
    return;
  }
  showShareBar(label, "ok");
  geoWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      latestPos = positionToPlain(pos);
      writeLiveLocations(false);
      showShareBar(`Sharing your location for ${myActiveDeliveries().length || count} deliver${(myActiveDeliveries().length || count) === 1 ? "y" : "ies"}. Keep this page open and the screen on.`, "ok");
    },
    (error) => {
      if (error.code === 1) {
        showShareBar("Location is blocked. Allow location for this site in Chrome so the admin can see where you are.", "warn");
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 }
  );
  requestWakeLock();
}

function stopLocationWatch() {
  if (geoWatchId !== null) navigator.geolocation.clearWatch(geoWatchId);
  geoWatchId = null;
  latestPos = null;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  hideShareBar();
}

// Called on every render: starts/stops sharing to match this rider's open
// deliveries, and removes the live pin of any delivery that has finished.
function syncRiderSharing() {
  if (!currentIsDriver) return;
  const active = myActiveDeliveries();
  const activeIds = new Set(active.map((o) => o.id));

  // Warm up the location once while this rider has approved deliveries waiting, so the position is
  // already known (and the permission already answered) when they tap "On the way".
  if (!locationWarmedUp && allOrders.some((o) => o.status === "approved" && !isPickupOrder(o))) {
    locationWarmedUp = true;
    readPosition(8000);
  }

  sharedOrderIds.forEach((id) => {
    if (!activeIds.has(id)) {
      deleteDoc(doc(db, LOCATIONS_COLLECTION, id)).catch(() => {});
      sharedOrderIds.delete(id);
    }
  });

  if (active.length === 0) {
    stopLocationWatch();
    if (hiddenFromUids.size) { hiddenFromUids.clear(); saveHiddenList(); } // temporary: reset
    return;
  }
  const hadNew = active.some((o) => !sharedOrderIds.has(o.id));
  active.forEach((o) => sharedOrderIds.add(o.id));
  startLocationWatch(active.length);
  if (hadNew) writeLiveLocations(true);
}

// ---- Viewer side: see where the rider is ----
// One listener per on-the-way delivery (not the whole collection): the rules
// can hide a rider's location from specific accounts, and a collection-wide
// query would be rejected outright if even one document were hidden.
const locationUnsubs = new Map();
let locationTickerStarted = false;

function startRiderLocationListener() {
  if (!locationTickerStarted) {
    locationTickerStarted = true;
    setInterval(() => {
      document.querySelectorAll(".order-detail__track[data-ts]").forEach(renderTrackAge);
    }, 15000);
  }
  const wanted = new Set(
    allOrders
      .filter((o) => o.status === "on_the_way" && !isPickupOrder(o))
      // A driver only needs their own pin, not every rider's.
      .filter((o) => !currentIsDriver || o.driverUid === auth.currentUser?.uid)
      // Only the order whose details are open is watched: every location update is one read per
      // watcher, so watching every delivery in the background would cost reads for nothing.
      .filter((o) => o.id === expandedOrderMainRow?.dataset.orderId)
      .map((o) => o.id)
  );
  locationUnsubs.forEach((unsub, id) => {
    if (!wanted.has(id)) { unsub(); locationUnsubs.delete(id); riderLocations.delete(id); }
  });
  wanted.forEach((id) => {
    if (locationUnsubs.has(id)) return;
    const unsub = onSnapshot(
      doc(db, LOCATIONS_COLLECTION, id),
      (snap) => {
        if (snap.exists()) riderLocations.set(id, snap.data()); else riderLocations.delete(id);
        refreshRiderTracks();
      },
      (error) => {
        // Permission denied = the rider hid their location from this account.
        riderLocations.set(id, { hidden: true });
        unsub();
        // Try again in a while in case they un-hide.
        setTimeout(() => { locationUnsubs.delete(id); riderLocations.delete(id); startRiderLocationListener(); }, 20000);
        refreshRiderTracks();
        if (error.code !== "permission-denied") console.error("Couldn't load rider location:", error);
      }
    );
    locationUnsubs.set(id, unsub);
  });
}

function refreshRiderTracks() {
  document.querySelectorAll(".order-detail__track").forEach((box) => {
    const order = allOrders.find((o) => o.id === box.dataset.orderId);
    if (order) fillRiderTrack(box, order);
  });
}

function trackEl(box, tag, cls) {
  let el = box.querySelector(`.${cls}`);
  if (!el) {
    el = document.createElement(tag);
    el.className = cls;
    box.appendChild(el);
  }
  return el;
}

function mapsPointUrl(p) {
  return `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
}

// Embedded map: a route line when there are two points, otherwise one pin.
function showTrackMap(box, from, to) {
  const key = `${from.lat.toFixed(4)},${from.lng.toFixed(4)}|${to ? `${to.lat},${to.lng}` : ""}`;
  let wrap = box.querySelector(".track-map");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "order-detail__map-wrap track-map";
    const iframe = document.createElement("iframe");
    iframe.className = "order-detail__map";
    iframe.loading = "lazy";
    iframe.referrerPolicy = "no-referrer-when-downgrade";
    iframe.title = "Rider location map";
    wrap.appendChild(iframe);
    box.appendChild(wrap);
  }
  if (wrap.dataset.key === key) return; // hasn't moved: don't reload the map
  wrap.dataset.key = key;
  wrap.querySelector("iframe").src = to
    ? `https://maps.google.com/maps?saddr=${from.lat},${from.lng}&daddr=${to.lat},${to.lng}&output=embed`
    : `https://maps.google.com/maps?q=${from.lat},${from.lng}&output=embed`;
}

function renderTrackAge(box) {
  const note = box.querySelector(".track-note");
  const ts = Number(box.dataset.ts);
  if (!note || !ts) return;
  const ms = Math.max(0, Date.now() - ts);
  const secs = Math.round(ms / 1000);
  const ago = secs < 60 ? `${secs} s ago` : `${Math.round(secs / 60)} min ago`;
  const stale = ms > STALE_AFTER_MS;
  note.textContent = stale
    ? `Last seen ${ago}. The rider may have left the page or lost signal.`
    : `Updated ${ago}`;
  note.classList.toggle("is-stale", stale);
}

function buildRiderTrack(order) {
  if (isPickupOrder(order)) return null;
  if (order.status !== "on_the_way" && !order.deliveredLocation && !order.onTheWayLocation) return null;
  const box = document.createElement("div");
  box.className = "order-detail__track";
  box.dataset.orderId = order.id;
  fillRiderTrack(box, order);
  return box;
}

function fillRiderTrack(box, order) {
  const cust = toCoord(order.deliveryLat, 90) !== null && toCoord(order.deliveryLng, 180) !== null
    ? { lat: toCoord(order.deliveryLat, 90), lng: toCoord(order.deliveryLng, 180) }
    : null;
  const start = order.onTheWayLocation && toCoord(order.onTheWayLocation.lat, 90) !== null ? order.onTheWayLocation : null;
  const end = order.deliveredLocation && toCoord(order.deliveredLocation.lat, 90) !== null ? order.deliveredLocation : null;
  const title = trackEl(box, "p", "track-title");
  const note = trackEl(box, "p", "track-note");
  let link = box.querySelector(".track-link");

  if (order.status === "on_the_way") {
    const live = riderLocations.get(order.id);
    title.textContent = "Rider location (live)";
    if (live?.hidden) {
      delete box.dataset.ts;
      note.classList.remove("is-stale");
      note.textContent = "The rider has turned off live location.";
      box.querySelector(".track-map")?.remove();
      box.querySelector(".track-link")?.remove();
      return;
    }
    if (live) {
      box.dataset.ts = String(live.updatedAt?.toMillis?.() || Date.now());
      renderTrackAge(box);
      showTrackMap(box, live, cust);
      if (!link) { link = document.createElement("a"); link.className = "order-detail__map-link track-link"; link.target = "_blank"; link.rel = "noopener noreferrer"; box.appendChild(link); }
      link.href = mapsPointUrl(live);
      link.textContent = "Open rider location in Google Maps ↗";
      return;
    }
    delete box.dataset.ts;
    note.classList.remove("is-stale");
    note.textContent = "Waiting for the rider's live location. Their phone must keep this page open with location allowed.";
    if (start) showTrackMap(box, start, cust);
    return;
  }

  // Finished delivery: show where the rider was.
  delete box.dataset.ts;
  note.classList.remove("is-stale");
  if (!end && !start) { box.remove(); return; }
  title.textContent = order.status === "delivered" ? "Delivery location" : "Where the rider was";
  const parts = [];
  if (end) {
    parts.push(`${order.status === "delivered" ? "Delivered" : "Marked undeliverable"} here: ${formatDistance(cust ? distanceMeters(end, cust) : 0)}${cust ? " from the customer's pin" : ""}`.replace(/: 0 m$/, ""));
  }
  if (start) parts.push("Set off from the point where \"On the Way\" was tapped.");
  note.textContent = parts.join(" ");
  showTrackMap(box, start || end, start && end ? end : null);
  if (!link) { link = document.createElement("a"); link.className = "order-detail__map-link track-link"; link.target = "_blank"; link.rel = "noopener noreferrer"; box.appendChild(link); }
  link.href = mapsPointUrl(end || start);
  link.textContent = "Open in Google Maps ↗";
}

// What the admin sees as the rider: the profile name when we have it, else
// the name saved on the order, else the email (very old orders).
const riderNamesByUid = new Map(); // uid -> real name from the employee profile
const riderLookupsStarted = new Set();

function riderLabel(order) {
  const profileName = order.driverUid ? riderNamesByUid.get(order.driverUid) : "";
  return profileName
    || (typeof order.driverName === "string" && order.driverName.trim())
    || order.driverEmail
    || "";
}

// Looks up the real names of any riders on the loaded orders, once each,
// and redraws the table when new names arrive.
async function loadRiderNames() {
  const uids = [...new Set(allOrders.map((o) => o.driverUid).filter(Boolean))]
    .filter((uid) => !riderLookupsStarted.has(uid));
  if (uids.length === 0) return;
  uids.forEach((uid) => riderLookupsStarted.add(uid));

  let found = false;
  await Promise.all(uids.map(async (uid) => {
    try {
      const snap = await getDoc(doc(db, "employees", uid));
      const name = profileName(snap);
      if (name) {
        riderNamesByUid.set(uid, name);
        found = true;
      }
    } catch (error) {
      console.error("Couldn't load a rider's name:", error);
    }
  }));
  if (found) render();
}

// Reminder for riders: live tracking only works while this page stays open.
function showKeepOpenNotice() {
  confirmDialog(
    "Keep this page open and your screen on while you deliver, so the store can see where you are. Don't switch to other apps or lock your phone. If you need to leave the page, your last location stays saved.",
    { title: "Keep this page open", confirmLabel: "Got it" }
  );
  document.querySelector('.confirm-overlay [data-action="cancel"]')?.remove();
}

async function handleMarkOnTheWay(order) {
  const confirmed = await confirmDialog(
    `Mark order #${shortOrderId(order.id)} as on the way?`,
    { title: "Mark on the way?", confirmLabel: "Confirm" }
  );
  if (!confirmed) return;

  await updateDoc(doc(db, ORDERS_COLLECTION, order.id), {
    status: "on_the_way",
    ...(await currentDriverStamp()),
    ...(await locationField("onTheWayLocation"))
  });
  sendOrderNotification(order, "Order On The Way", `Your order #${shortOrderId(order.id)} is on its way!`);
  if (currentIsDriver) showKeepOpenNotice();
  await reloadAfterAction();
}

// Delivered is final: the order is marked delivered (and paid) right away.
// No customer confirmation step and no countdown timer.
async function handleMarkDelivered(order) {
  const isPaid = await confirmDialog(
    "Confirm whether the customer has paid for this order.",
    { title: "Is the delivery paid?", confirmLabel: "Yes, Paid" }
  );
  if (!isPaid) return;

  await updateDoc(doc(db, ORDERS_COLLECTION, order.id), {
    status: "delivered",
    isPaid: true,
    // Orders already stamped when they went "on the way" keep that driver.
    ...(order.driverUid ? {} : await currentDriverStamp()),
    ...(await locationField("deliveredLocation"))
  });
  sendOrderNotification(order, "Order Delivered", `Your order #${shortOrderId(order.id)} has been delivered. Thank you!`);
  await reloadAfterAction();
}

// ---- Store pickup (admin only; see firestore.rules) ----------------
async function handleMarkReadyForPickup(order) {
  const branch = pickupBranchName(order);
  const confirmed = await confirmDialog(
    `Tell ${order.customerName || "the customer"} that order #${shortOrderId(order.id)} is ready for pickup${branch ? ` at ${branch}` : ""}? They'll get a notification.`,
    { title: "Ready for pickup?", confirmLabel: "Yes, Ready" }
  );
  if (!confirmed) return;

  await updateDoc(doc(db, ORDERS_COLLECTION, order.id), {
    status: "ready_for_pickup",
    readyForPickupAt: serverTimestamp()
  });
  sendOrderNotification(
    order,
    "Ready for Pickup",
    `Your order #${shortOrderId(order.id)} is ready for pickup${branch ? ` at ${branch}` : ""}!`
  );
  await reloadAfterAction();
}

async function handleMarkPickedUp(order) {
  const confirmed = await confirmDialog(
    `Confirm that ${order.customerName || "the customer"} picked up order #${shortOrderId(order.id)} and has paid.`,
    { title: "Order picked up?", confirmLabel: "Yes, Picked Up" }
  );
  if (!confirmed) return;

  await updateDoc(doc(db, ORDERS_COLLECTION, order.id), {
    status: "delivered", // the completed state every report already counts
    isPaid: true,
    pickedUpAt: serverTimestamp()
  });
  sendOrderNotification(order, "Order Picked Up", `Your order #${shortOrderId(order.id)} was picked up. Thank you!`);
  await reloadAfterAction();
}

// ====================================================================
// CHUNK 6 — MARK UNDELIVERABLE (needs a reason, so it's its own modal
// rather than a simple confirm)
// ====================================================================
function openUndeliverableModal(order) {
  pendingUndeliverableOrderId = order.id;
  resetReasonPicker("undeliverable-reason-select", "undeliverable-reason");
  document.getElementById("undeliverable-restock").checked = true;
  document.getElementById("undeliverable-status").hidden = true;
  document.getElementById("undeliverable-modal-overlay").hidden = false;
}

function closeUndeliverableModal() {
  document.getElementById("undeliverable-modal-overlay").hidden = true;
  pendingUndeliverableOrderId = null;
}

function wireUndeliverableModal() {
  setupReasonPicker("undeliverable-reason-select", "undeliverable-reason", UNDELIVERABLE_REASONS);
  setupReasonPicker("reject-reason-select", "reject-reason", REJECT_REASONS);
  document.getElementById("undeliverable-modal-close").addEventListener("click", closeUndeliverableModal);
  document.getElementById("undeliverable-cancel").addEventListener("click", closeUndeliverableModal);
  document.getElementById("undeliverable-confirm").addEventListener("click", handleConfirmUndeliverable);
}

async function handleConfirmUndeliverable() {
  const reason = readReason("undeliverable-reason-select", "undeliverable-reason");
  const statusEl = document.getElementById("undeliverable-status");

  if (!reason) {
    statusEl.textContent = "Please enter a reason.";
    statusEl.dataset.kind = "error";
    statusEl.hidden = false;
    return;
  }

  const confirmBtn = document.getElementById("undeliverable-confirm");
  const wantsRestock = document.getElementById("undeliverable-restock").checked;
  let stockNote = "";
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Saving...";

  try {
    const affectedOrder = allOrders.find((o) => o.id === pendingUndeliverableOrderId);
    await updateDoc(doc(db, ORDERS_COLLECTION, pendingUndeliverableOrderId), {
      status: "undelivered",
      deliveryIssueReason: reason,
      ...(affectedOrder?.driverUid ? {} : await currentDriverStamp()),
      ...(await locationField("deliveredLocation"))
    });
    if (affectedOrder) {
      sendOrderNotification(affectedOrder, "Delivery Issue", `There was a delivery issue with your order #${shortOrderId(affectedOrder.id)}: ${reason}`);
    }
    // If the items are coming back, put them back on the shelf (once). Never blocks the status change.
    if (wantsRestock && affectedOrder?.userId) {
      try {
        await restockUndelivered(affectedOrder.userId, affectedOrder.id);
      } catch (error) {
        if (error.code !== "nothing_to_restock") {
          console.error("Couldn't return the stock for an undeliverable order:", error);
          stockNote = "The order was marked undeliverable, but its items could not be returned to stock automatically. Please check the stock for this order.";
        }
      }
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
  if (stockNote) await confirmDialog(stockNote, { title: "Stock not returned", confirmLabel: "OK" });
}
