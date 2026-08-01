import { db } from "./firebase-config.js";
import {
  collection, getDocs, query, where
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getProducts } from "./ProductCache.js";
import { getNotifications } from "./NotificationCache.js";
import { getClearedSet } from "./ReadStatus.js";

// ====================================================================
// CHUNK 0 — CONFIG
// This page's own data needs only. Sidebar/auth/identity/clock/logout
// all live in Sidebar.js now and are shared by every page.
// ====================================================================
const STOCK_FIELD = "stockCount";
const PRODUCT_AVAILABLE_FIELD = "available";
const LOW_STOCK_THRESHOLD = 99;
const CRITICAL_STOCK_THRESHOLD = 49;

const ORDERS_COLLECTION = "orders";
const ORDER_DATE_FIELD = "createdAt";

// ====================================================================
// CHUNK 1 — WAIT FOR THE SHARED SIDEBAR TO FINISH ITS OWN SETUP
// ----------------------------------------------------------------
// Sidebar.js handles the auth guard and fires this event once a
// signed-in user is confirmed and identity/clock are wired up. This
// page's own content only starts loading after that.
// ====================================================================
document.addEventListener("sidebar:ready", (event) => {
  const { role, user } = event.detail;
  applyRoleVisibility(role);
  loadStats();
  loadRecentNotifications(user.uid);
});

// ====================================================================
// CHUNK 1B — ROLE-BASED QUICK ACTION
// ----------------------------------------------------------------
// Employees can't add products (that's Admin-only), so instead of
// hiding this slot and leaving a gap in the grid, it becomes a
// genuinely useful employee action: jump straight into Inventory
// pre-filtered to what actually needs restocking.
// ====================================================================
function applyRoleVisibility(role) {
  const action = document.getElementById("qa-role-action");
  const icon = document.getElementById("qa-role-icon");
  const label = document.getElementById("qa-role-label");

  if (role === "employee") {
    action.href = "Inventory.html?filter=attention";
    label.textContent = "Check Low Stock";
    icon.innerHTML = `
      <path d="M12 4L21 19.5H3L12 4Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
      <path d="M12 10V14.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
      <circle cx="12" cy="17" r="0.9" fill="currentColor"/>
    `;
  }
  // Admin keeps the default markup already in Dashboard.html (Add Product).
}

// ====================================================================
// CHUNK 2 — LIVE STATS (Total Products, Low Stock, Orders Today)
// ====================================================================
async function loadStats() {
  await Promise.all([loadProductStats(), loadOrdersTodayStat()]);
}

async function loadProductStats() {
  try {
    const products = await getProducts();
    document.getElementById("stat-products-value").textContent = products.length;

    const lowStockCount = products.filter((product) => {
      const stock = product[STOCK_FIELD];
      const outOfStock = product[PRODUCT_AVAILABLE_FIELD] === false || stock === 0;
      return outOfStock || (typeof stock === "number" && stock <= LOW_STOCK_THRESHOLD);
    }).length;

    // The banner is specifically titled "Critically Low Stock Items
    // Warning" — so it only counts items actually in the critical
    // tier (not merely "low", and not "out of stock" either, since
    // an item at zero isn't "critically low", it's already gone).
    const criticalCount = products.filter((product) => {
      const stock = product[STOCK_FIELD];
      const isAvailable = product[PRODUCT_AVAILABLE_FIELD];
      return isAvailable !== false && typeof stock === "number" &&
        stock > 0 && stock <= CRITICAL_STOCK_THRESHOLD;
    }).length;

    document.getElementById("stat-lowstock-value").textContent = lowStockCount;
    updateLowStockBanner(criticalCount);
  } catch (error) {
    console.error("Couldn't load product stats:", error);
    document.getElementById("stat-products-value").textContent = "—";
    document.getElementById("stat-lowstock-value").textContent = "—";
  }
}

function updateLowStockBanner(count) {
  const banner = document.getElementById("low-stock-banner");
  const countLabel = document.getElementById("low-stock-count");
  countLabel.textContent = count;
  banner.hidden = count === 0;
}

async function loadOrdersTodayStat() {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTomorrow = new Date(startOfToday);
    startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

    const ordersRef = collection(db, ORDERS_COLLECTION);
    const todaysOrders = query(
      ordersRef,
      where(ORDER_DATE_FIELD, ">=", startOfToday),
      where(ORDER_DATE_FIELD, "<", startOfTomorrow)
    );
    const snap = await getDocs(todaysOrders);

    document.getElementById("stat-orders-value").textContent = snap.size;
  } catch (error) {
    console.error("Couldn't load today's orders:", error);
    document.getElementById("stat-orders-value").textContent = "—";
  }
}

// ====================================================================
// CHUNK 3 — RECENT NOTIFICATIONS FEED
// ====================================================================
async function loadRecentNotifications(uid) {
  const list = document.getElementById("notif-list");

  try {
    const notifications = await getNotifications();
    const clearedSet = getClearedSet(uid);
    const visible = notifications.filter((n) => !clearedSet.has(n.id));

    if (visible.length === 0) {
      list.innerHTML = `<li class="notif-list__empty">No recent notifications.</li>`;
      return;
    }

    const recent = [...visible]
      .sort((a, b) => (b.createdAtMillis || 0) - (a.createdAtMillis || 0))
      .slice(0, 5);

    list.innerHTML = "";
    recent.forEach((n) => {
      const timeLabel = n.createdAtMillis
        ? new Date(n.createdAtMillis).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
        : "";

      const item = document.createElement("li");
      item.className = "notif-list__item";
      item.innerHTML = `
        <span class="notif-list__message"></span>
        <span class="notif-list__time"></span>
      `;
      item.querySelector(".notif-list__message").textContent = n.message;
      item.querySelector(".notif-list__time").textContent = timeLabel;
      list.appendChild(item);
    });
  } catch (error) {
    console.error("Couldn't load notifications:", error);
    list.innerHTML = `<li class="notif-list__empty">Couldn't load notifications right now.</li>`;
  }
}
