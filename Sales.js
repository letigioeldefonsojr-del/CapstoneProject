import { db } from "./firebase-config.js";
import {
  collection, query, where, getDocs, doc, getDoc, Timestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const ORDERS_COLLECTION = "orders";
const STOCK_MOVEMENTS_COLLECTION = "stockMovements";
const PRODUCTS_COLLECTION = "products";

document.addEventListener("sidebar:ready", (event) => {
  // Admin-only page. The nav link is already hidden for employees
  // (see Sidebar.js), but that alone doesn't stop someone from typing
  // the URL directly — this is the actual enforcement.
  if (event.detail.role !== "admin") {
    window.location.replace("Dashboard.html");
    return;
  }

  const dateInput = document.getElementById("sales-date-input");
  const todayBtn = document.getElementById("sales-today-btn");

  const today = new Date();
  dateInput.value = formatDateForInput(today);

  dateInput.addEventListener("change", () => loadSalesForDate(dateInput.value));
  todayBtn.addEventListener("click", () => {
    dateInput.value = formatDateForInput(new Date());
    loadSalesForDate(dateInput.value);
  });

  loadSalesForDate(dateInput.value);
});

function formatDateForInput(dateObj) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}`;
}

async function loadSalesForDate(dateString) {
  const container = document.getElementById("sales-content");
  container.innerHTML = `<p class="forecast-loading">Loading sales...</p>`;

  try {
    // Local-time day boundaries, same convention Dashboard.js already
    // uses for "Orders Today" — [start of this day, start of next
    // day), in the browser's own local time.
    const [year, month, day] = dateString.split("-").map(Number);
    const startOfDay = new Date(year, month - 1, day, 0, 0, 0, 0);
    const startOfNextDay = new Date(startOfDay);
    startOfNextDay.setDate(startOfNextDay.getDate() + 1);

    const [onlineSales, inPersonSales] = await Promise.all([
      fetchOnlineSales(startOfDay, startOfNextDay),
      fetchInPersonSales(startOfDay, startOfNextDay)
    ]);

    // In-person sales logged before the price-at-time-of-sale feature
    // existed have no unitPrice at all — those need the product's
    // CURRENT price as a best-effort estimate, clearly labeled as
    // such rather than presented as an exact figure.
    const productIdsNeedingCurrentPrice = [...new Set(
      inPersonSales.filter((s) => s.unitPrice == null).map((s) => s.productId)
    )];
    const currentPrices = await fetchCurrentPrices(productIdsNeedingCurrentPrice);

    inPersonSales.forEach((sale) => {
      if (sale.unitPrice == null) {
        sale.unitPrice = currentPrices.get(sale.productId) ?? null;
        sale.priceIsEstimated = true;
      } else {
        sale.priceIsEstimated = false;
      }
      sale.revenue = sale.unitPrice != null ? sale.unitPrice * sale.unitsSold : null;
    });

    const combined = [...onlineSales, ...inPersonSales].sort((a, b) => b.timestampMillis - a.timestampMillis);

    render(container, combined, dateString);
  } catch (error) {
    console.error("Couldn't load sales:", error);
    container.innerHTML = `<p class="forecast-loading">Couldn't load sales right now.</p>`;
  }
}

async function fetchOnlineSales(startOfDay, startOfNextDay) {
  const q = query(
    collection(db, ORDERS_COLLECTION),
    where("status", "==", "delivered"),
    where("createdAt", ">=", Timestamp.fromDate(startOfDay)),
    where("createdAt", "<", Timestamp.fromDate(startOfNextDay))
  );
  const snap = await getDocs(q);

  return snap.docs.map((docSnap) => {
    const data = docSnap.data();
    return {
      source: "online",
      id: docSnap.id,
      customerName: data.customerName || "—",
      itemCount: data.itemCount ?? (Array.isArray(data.items) ? data.items.length : 0),
      revenue: typeof data.total === "number" ? data.total : null,
      priceIsEstimated: false, // online orders always have a real, stored total
      timestampMillis: data.createdAt?.toMillis?.() ?? 0
    };
  });
}

async function fetchInPersonSales(startOfDay, startOfNextDay) {
  const q = query(
    collection(db, STOCK_MOVEMENTS_COLLECTION),
    where("type", "==", "sale"),
    where("createdAt", ">=", Timestamp.fromDate(startOfDay)),
    where("createdAt", "<", Timestamp.fromDate(startOfNextDay))
  );
  const snap = await getDocs(q);

  return snap.docs.map((docSnap) => {
    const data = docSnap.data();
    const unitsSold = (data.previousStock ?? 0) - (data.newStock ?? 0);
    return {
      source: "in-person",
      id: docSnap.id,
      productId: data.productId,
      productName: data.variantName ? `${data.productName} — ${data.variantName}` : (data.productName || "Product"),
      unitsSold,
      unitPrice: typeof data.unitPrice === "number" ? data.unitPrice : null,
      performedByEmail: data.performedByEmail || "unknown",
      timestampMillis: data.createdAt?.toMillis?.() ?? 0
    };
  }).filter((s) => s.unitsSold > 0); // a "sale" movement with 0 or negative change isn't a real sale (shouldn't happen, but guards against bad data)
}

async function fetchCurrentPrices(productIds) {
  const prices = new Map();
  if (productIds.length === 0) return prices;

  // Firestore document reads don't support querying many arbitrary
  // IDs in one call the way a SQL "WHERE id IN (...)" would beyond a
  // small batch limit — fetching each individually here is simplest
  // and this list is naturally small (distinct products sold that day
  // without a logged price, not the whole catalog).
  await Promise.all(productIds.map(async (productId) => {
    try {
      const snap = await getDoc(doc(db, PRODUCTS_COLLECTION, productId));
      if (snap.exists()) {
        const data = snap.data();
        if (typeof data.price === "number") prices.set(productId, data.price);
      }
    } catch (error) {
      console.error(`Couldn't fetch current price for product ${productId}:`, error);
    }
  }));

  return prices;
}

function render(container, combined, dateString) {
  const totalRevenue = combined.reduce((sum, s) => sum + (s.revenue ?? 0), 0);
  const onlineCount = combined.filter((s) => s.source === "online").length;
  const inPersonCount = combined.filter((s) => s.source === "in-person").length;
  const hasEstimated = combined.some((s) => s.priceIsEstimated);

  const dateLabel = new Date(dateString + "T00:00:00").toLocaleDateString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric"
  });

  container.innerHTML = `
    <div class="forecast-summary-grid">
      <div class="panel forecast-stat-card">
        <span class="forecast-stat-card__value">₱${totalRevenue.toFixed(2)}</span>
        <span class="forecast-stat-card__label">Total Revenue</span>
      </div>
      <div class="panel forecast-stat-card">
        <span class="forecast-stat-card__value">${combined.length}</span>
        <span class="forecast-stat-card__label">Total Transactions</span>
      </div>
      <div class="panel forecast-stat-card">
        <span class="forecast-stat-card__value">${onlineCount}</span>
        <span class="forecast-stat-card__label">Online Orders</span>
      </div>
      <div class="panel forecast-stat-card">
        <span class="forecast-stat-card__value">${inPersonCount}</span>
        <span class="forecast-stat-card__label">In-Person Sales</span>
      </div>
    </div>

    <div class="panel">
      <h3 class="panel__title">Sales — ${escapeHtmlSales(dateLabel)}</h3>
      ${hasEstimated ? `<p class="sales-estimate-note">Some in-person sales shown below are from before exact prices were tracked per sale — those are estimated using each product's current price, and marked "(estimated)".</p>` : ""}
      ${combined.length === 0 ? `<p class="notif-list__empty">No sales recorded for this day.</p>` : buildSalesTable(combined)}
    </div>
  `;
}

function buildSalesTable(combined) {
  const rows = combined.map((sale) => {
    const time = new Date(sale.timestampMillis).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    if (sale.source === "online") {
      return `
        <tr>
          <td>${time}</td>
          <td><span class="role-pill role-pill--admin">Online</span></td>
          <td>${escapeHtmlSales(sale.customerName)} — ${sale.itemCount} item${sale.itemCount === 1 ? "" : "s"}</td>
          <td style="text-align:right;">${sale.revenue != null ? `₱${sale.revenue.toFixed(2)}` : "—"}</td>
        </tr>
      `;
    }

    const revenueLabel = sale.revenue != null
      ? `₱${sale.revenue.toFixed(2)}${sale.priceIsEstimated ? " (estimated)" : ""}`
      : "—";

    return `
      <tr>
        <td>${time}</td>
        <td><span class="role-pill role-pill--employee">In-Person</span></td>
        <td>${escapeHtmlSales(sale.productName)} × ${sale.unitsSold} — by ${escapeHtmlSales(sale.performedByEmail)}</td>
        <td style="text-align:right;">${revenueLabel}</td>
      </tr>
    `;
  }).join("");

  return `
    <div class="accounts-table-scroll">
      <table class="inventory-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Type</th>
            <th>Details</th>
            <th style="text-align:right;">Revenue</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function escapeHtmlSales(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
