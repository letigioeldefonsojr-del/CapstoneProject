import { db } from "./firebase-config.js";
import {
  collection, query, where, getDocs, doc, getDoc, Timestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const ORDERS_COLLECTION = "orders";
const STOCK_MOVEMENTS_COLLECTION = "stockMovements";
const PRODUCTS_COLLECTION = "products";

let viewMode = "day"; // "day" | "week" | "month" | "year"

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

  document.querySelectorAll("#sales-view-toggle .tab-row__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      viewMode = btn.dataset.view;
      document.querySelectorAll("#sales-view-toggle .tab-row__btn").forEach((b) =>
        b.classList.toggle("is-active", b === btn)
      );
      loadSales();
    });
  });

  dateInput.addEventListener("change", loadSales);
  todayBtn.addEventListener("click", () => {
    dateInput.value = formatDateForInput(new Date());
    loadSales();
  });

  loadSales();
});

function formatDateForInput(dateObj) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}`;
}

// Computes [start, end) for whichever view is active, anchored on the
// date picker's value. Week starts on Sunday, matching the same
// convention Orders.js already uses for its own "group by week"
// feature, so the two pages don't disagree with each other.
function computeDateRange(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  const anchor = new Date(year, month - 1, day, 0, 0, 0, 0);

  if (viewMode === "week") {
    const start = new Date(anchor);
    start.setDate(anchor.getDate() - anchor.getDay()); // back up to that week's Sunday
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return { start, end };
  }

  if (viewMode === "month") {
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
    return { start, end };
  }

  if (viewMode === "year") {
    const start = new Date(anchor.getFullYear(), 0, 1);
    const end = new Date(anchor.getFullYear() + 1, 0, 1);
    return { start, end };
  }

  // "day"
  const start = anchor;
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return { start, end };
}

function formatRangeLabel(start, end) {
  if (viewMode === "year") {
    return String(start.getFullYear());
  }
  if (viewMode === "month") {
    return start.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }
  if (viewMode === "week") {
    const lastDayOfWeek = new Date(end);
    lastDayOfWeek.setDate(end.getDate() - 1);
    return `Week of ${start.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} – ${lastDayOfWeek.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  }
  return start.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

async function loadSales() {
  const container = document.getElementById("sales-content");
  container.innerHTML = `<p class="forecast-loading">Loading sales...</p>`;

  try {
    const dateInput = document.getElementById("sales-date-input");
    const { start, end } = computeDateRange(dateInput.value);

    const [onlineSales, inPersonSales] = await Promise.all([
      fetchOnlineSales(start, end),
      fetchInPersonSales(start, end)
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

    render(container, combined, formatRangeLabel(start, end));
  } catch (error) {
    console.error("Couldn't load sales:", error);
    container.innerHTML = `<p class="forecast-loading">Couldn't load sales right now.</p>`;
  }
}

async function fetchOnlineSales(start, end) {
  const q = query(
    collection(db, ORDERS_COLLECTION),
    where("status", "==", "delivered"),
    where("createdAt", ">=", Timestamp.fromDate(start)),
    where("createdAt", "<", Timestamp.fromDate(end))
  );
  const snap = await getDocs(q);

  return snap.docs.map((docSnap) => {
    const data = docSnap.data();
    return {
      source: "online",
      id: docSnap.id,
      // Full raw order data kept here too — needed to build a receipt
      // on demand without a second fetch, since it's already sitting
      // right here from this same query.
      orderData: { id: docSnap.id, ...data },
      customerName: data.customerName || "—",
      itemCount: data.itemCount ?? (Array.isArray(data.items) ? data.items.length : 0),
      revenue: typeof data.total === "number" ? data.total : null,
      priceIsEstimated: false, // online orders always have a real, stored total
      timestampMillis: data.createdAt?.toMillis?.() ?? 0
    };
  });
}

async function fetchInPersonSales(start, end) {
  const q = query(
    collection(db, STOCK_MOVEMENTS_COLLECTION),
    where("type", "==", "sale"),
    where("createdAt", ">=", Timestamp.fromDate(start)),
    where("createdAt", "<", Timestamp.fromDate(end))
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

function render(container, combined, rangeLabel) {
  const totalRevenue = combined.reduce((sum, s) => sum + (s.revenue ?? 0), 0);
  const onlineCount = combined.filter((s) => s.source === "online").length;
  const inPersonCount = combined.filter((s) => s.source === "in-person").length;
  const hasEstimated = combined.some((s) => s.priceIsEstimated);

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
      <h3 class="panel__title">Sales — ${escapeHtmlSales(rangeLabel)}</h3>
      ${hasEstimated ? `<p class="sales-estimate-note">Some in-person sales shown below are from before exact prices were tracked per sale — those are estimated using each product's current price, and marked "(estimated)".</p>` : ""}
      ${combined.length === 0 ? `<p class="notif-list__empty">No sales recorded for this period.</p>` : buildSalesTable(combined)}
    </div>
  `;

  // Wire receipt buttons after the table is actually in the DOM —
  // only online orders get one, since in-person sales are single-item
  // transactions without the richer order structure a receipt needs.
  container.querySelectorAll("[data-receipt-order-id]").forEach((btn) => {
    const orderData = combined.find((s) => s.id === btn.dataset.receiptOrderId)?.orderData;
    if (orderData) {
      btn.addEventListener("click", () => downloadReceipt(orderData));
    }
  });
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
          <td style="text-align:right;"><button type="button" class="btn-outline" data-receipt-order-id="${sale.id}">Download Receipt</button></td>
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
        <td></td>
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
            <th></th>
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

function shortOrderId(id) {
  return id.slice(0, 8).toUpperCase();
}

// ====================================================================
// RECEIPT / INVOICE PDF (moved here from Orders.js)
// ----------------------------------------------------------------
// Generated fresh, in the browser, the moment someone clicks the
// button — nothing pre-generated or stored ahead of time.
//
// Builds the receipt as real, styled HTML first (a hidden div,
// removed right after) — the ₱ symbol renders correctly there, same
// as it already does everywhere else in this app, since that's just
// normal browser text rendering. html2canvas then captures that HTML
// as an image, which jsPDF embeds into the actual PDF page. This
// sidesteps jsPDF's own built-in fonts entirely, which is what
// couldn't render ₱ reliably in the first place.
//
// Deliberately no <table> anywhere in the receipt's own markup below
// — html2canvas doesn't reliably replicate table layout, since it
// reimplements CSS layout itself rather than using a real browser
// engine for the capture. Plain flexbox divs with fixed pixel widths
// render far more predictably.
// ====================================================================
async function downloadReceipt(order) {
  const html = buildReceiptHtml(order);

  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-9999px";
  container.style.top = "0";
  container.style.width = "650px";
  container.innerHTML = html;
  document.body.appendChild(container);

  const logoImg = container.querySelector("#receipt-logo");
  if (logoImg && !logoImg.complete) {
    await new Promise((resolve) => {
      logoImg.onload = resolve;
      logoImg.onerror = resolve;
    });
  }

  try {
    const canvas = await html2canvas(container, { scale: 2, backgroundColor: "#ffffff" });
    const imgData = canvas.toDataURL("image/png");

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: "px", format: [canvas.width / 2, canvas.height / 2] });
    pdf.addImage(imgData, "PNG", 0, 0, canvas.width / 2, canvas.height / 2);
    pdf.save(`Receipt-${shortOrderId(order.id)}.pdf`);
  } catch (error) {
    console.error("Couldn't generate receipt:", error);
  } finally {
    container.remove();
  }
}

function buildReceiptHtml(order) {
  const orderDate = order.createdAt?.toDate?.() ? order.createdAt.toDate().toLocaleString() : "—";
  const items = Array.isArray(order.items) ? order.items : [];
  const BRAND_GREEN = "#14532d";
  const CONTENT_WIDTH = 650;

  const itemRows = items.map((item) => {
    const name = item.flavor ? `${item.productName} — ${item.flavor}` : (item.productName || "Item");
    const unitPrice = typeof item.unitPrice === "number" ? `₱${item.unitPrice.toFixed(2)}` : "—";
    const subtotal = typeof item.subtotal === "number" ? `₱${item.subtotal.toFixed(2)}` : "—";
    return `
      <div style="display:flex; padding:6px 0; border-bottom:1px solid #eee;">
        <div style="width:250px; word-wrap:break-word; overflow-wrap:break-word;">${escapeHtmlSales(name)}</div>
        <div style="width:90px; text-align:right;">× ${item.amount ?? 1}</div>
        <div style="width:130px; text-align:right;">${unitPrice}</div>
        <div style="width:116px; text-align:right;">${subtotal}</div>
      </div>
    `;
  }).join("");

  const total = typeof order.total === "number" ? `₱${order.total.toFixed(2)}` : "—";

  return `
    <div style="box-sizing:border-box; width:${CONTENT_WIDTH}px; font-family: Arial, sans-serif; color: #222; padding: 32px; word-wrap: break-word; overflow-wrap: break-word;">
      <img id="receipt-logo" src="Logo.png" alt="Almares 328 Logo" style="display:block; margin:0 auto 12px; width:64px; height:64px; object-fit:contain;">
      <h2 style="text-align:center; margin:0 0 4px; color:${BRAND_GREEN}; font-size:20px; line-height:1.3;">Almares 328 Wholesale Grocery Store</h2>
      <p style="text-align:center; margin:0 0 20px; color:#666;">Official Receipt</p>
      <hr style="border:none; border-top:2px solid ${BRAND_GREEN}; margin-bottom:16px;">
      <div style="display:flex; justify-content:space-between; font-size:13px; margin-bottom:6px;">
        <span>Order ID: ${escapeHtmlSales(shortOrderId(order.id))}</span>
        <span>Date: ${escapeHtmlSales(orderDate)}</span>
      </div>
      <p style="font-size:13px; margin:0 0 4px;">Customer: ${escapeHtmlSales(order.customerName || "—")}</p>
      ${order.customerAddress ? `<p style="font-size:13px; margin:0 0 16px;">Delivery Address: ${escapeHtmlSales(order.customerAddress)}</p>` : "<div style='margin-bottom:16px;'></div>"}
      <hr style="border:none; border-top:1px solid #ccc; margin-bottom:12px;">
      <div style="display:flex; font-weight:bold; border-bottom:2px solid ${BRAND_GREEN}; color:${BRAND_GREEN}; padding-bottom:6px; font-size:13px;">
        <div style="width:250px;">Item</div>
        <div style="width:90px; text-align:right;">Qty</div>
        <div style="width:130px; text-align:right;">Unit Price</div>
        <div style="width:116px; text-align:right;">Subtotal</div>
      </div>
      <div style="font-size:13px;">${itemRows}</div>
      <hr style="border:none; border-top:2px solid ${BRAND_GREEN}; margin:12px 0;">
      <p style="text-align:right; font-size:16px; font-weight:bold; margin:0 0 20px; color:${BRAND_GREEN};">Total: ${total}</p>
      <p style="text-align:center; font-size:11px; color:#999;">Thank you for your business.</p>
    </div>
  `;
}
