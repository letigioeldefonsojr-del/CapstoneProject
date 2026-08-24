import { db } from "./firebase-config.js";
import {
  collection, query, where, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ====================================================================
// FEEDBACK & RATINGS
// ----------------------------------------------------------------
// Ratings and feedback are NOT a separate collection — they're stored
// directly on the order document itself. Confirmed from the mobile
// app's order_details_screen.dart: after a delivery is confirmed, the
// customer can optionally rate 1-5 stars and leave a comment, written
// as {rating, feedback, ratedAt} directly onto that orders/{orderId}
// document. A rating is fully optional — the customer can dismiss the
// dialog with nothing written at all.
// ====================================================================
const ORDERS_COLLECTION = "orders";

let allRatedOrders = [];
let currentView = "month"; // "month" | "all"
let sortOrder = "newest"; // "newest" | "oldest"

document.addEventListener("sidebar:ready", (event) => {
  // Admin-only page. The nav link is already hidden for employees
  // (see Sidebar.js), but that alone doesn't stop someone from typing
  // the URL directly — this is the actual enforcement.
  if (event.detail.role !== "admin") {
    window.location.replace("Dashboard.html");
    return;
  }
  loadFeedback();
});

function loadFeedback() {
  const container = document.getElementById("feedback-content");
  container.innerHTML = `<p class="forecast-loading">Loading feedback...</p>`;

  const q = query(collection(db, ORDERS_COLLECTION), where("rating", ">=", 1));

  // Real-time: fires immediately with current data, then again
  // automatically whenever a customer submits a new rating — no
  // manual reload needed on this end.
  onSnapshot(
    q,
    (snap) => {
      allRatedOrders = snap.docs
        .map((docSnap) => {
          const data = docSnap.data();
          return {
            id: docSnap.id,
            rating: data.rating,
            feedback: (data.feedback || "").trim(),
            customerName: data.customerName || "A customer",
            ratedAtMillis: data.ratedAt?.toMillis?.() || data.createdAt?.toMillis?.() || 0
          };
        })
        .sort((a, b) => b.ratedAtMillis - a.ratedAtMillis);

      render();
    },
    (error) => {
      console.error("Couldn't load feedback:", error);
      container.innerHTML = `<p class="forecast-loading">Couldn't load feedback right now.</p>`;
    }
  );
}

function render() {
  const container = document.getElementById("feedback-content");
  container.innerHTML = "";

  if (allRatedOrders.length === 0) {
    container.innerHTML = `
      <div class="forecast-empty">
        <h3>No ratings yet</h3>
        <p>Customers can rate their order out of 5 stars and leave a comment after delivery is confirmed, right from the app. Once they start rating, summaries and comments will show up here automatically.</p>
      </div>
    `;
    return;
  }

  const now = new Date();
  const monthOrders = allRatedOrders.filter((o) => {
    const d = new Date(o.ratedAtMillis);
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });

  const visibleOrders = currentView === "month" ? monthOrders : allRatedOrders;
  const monthLabel = now.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  container.appendChild(buildSummary(monthOrders, allRatedOrders, monthLabel));
  container.appendChild(buildFeedbackList(visibleOrders, monthLabel));
}

function buildSummary(monthOrders, allOrders, monthLabel) {
  const wrap = document.createElement("div");
  wrap.className = "forecast-summary-grid";

  const monthAvg = average(monthOrders.map((o) => o.rating));
  const allAvg = average(allOrders.map((o) => o.rating));

  const cards = [
    { value: monthOrders.length ? monthAvg.toFixed(1) : "—", label: `Average Rating (${monthLabel})`, avgForStars: monthOrders.length ? monthAvg : null },
    { value: monthOrders.length, label: `Ratings This Month` },
    { value: allOrders.length ? allAvg.toFixed(1) : "—", label: "Average Rating (All Time)", avgForStars: allOrders.length ? allAvg : null },
    { value: allOrders.length, label: "Total Ratings" }
  ];

  cards.forEach((card) => {
    const el = document.createElement("div");
    el.className = "panel forecast-stat-card";
    el.innerHTML = `
      <span class="forecast-stat-card__value"></span>
      <span class="forecast-stat-card__label"></span>
    `;
    el.querySelector(".forecast-stat-card__value").textContent = card.value;
    el.querySelector(".forecast-stat-card__label").textContent = card.label;

    if (card.avgForStars != null) {
      el.insertAdjacentHTML("beforeend", buildAverageStarsHtml(card.avgForStars));
    }

    wrap.appendChild(el);
  });

  return wrap;
}

// Proportional-fill star row: the filled portion's WIDTH reflects the
// decimal average exactly (e.g. 4.3/5 fills 86% of the 5th star, not
// just rounding to 4 whole stars) — built as two overlapping SVG star
// rows: a gray "track" row underneath, and a colored "fill" row on
// top, clipped to the exact percentage via a wrapping div with
// overflow:hidden. SVG (not text characters) so the clipping edge is
// crisp and consistent regardless of font/browser rendering.
function buildAverageStarsHtml(average) {
  const fillPercent = Math.max(0, Math.min(100, (average / 5) * 100));
  const tierClass = average >= 4 ? "rating-stars--high" : average >= 2.5 ? "rating-stars--mid" : "rating-stars--low";
  const starsSvgRow = Array(5).fill(STAR_SVG_FILLED).join("");

  return `
    <div class="rating-stars ${tierClass}">
      <div class="rating-stars__track">${starsSvgRow}</div>
      <div class="rating-stars__fill-clip" style="width:${fillPercent}%">
        <div class="rating-stars__fill">${starsSvgRow}</div>
      </div>
    </div>
  `;
}

const STAR_SVG_FILLED = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2.5L14.8 8.9L21.8 9.6L16.5 14.2L18 21.1L12 17.4L6 21.1L7.5 14.2L2.2 9.6L9.2 8.9L12 2.5Z"/></svg>`;

function buildFeedbackList(orders, monthLabel) {
  const section = document.createElement("div");
  section.className = "panel forecast-section";
  section.innerHTML = `
    <div class="feedback-list__header">
      <div>
        <h3 class="forecast-section__title-text" style="margin:0;"></h3>
        <p class="forecast-section__subtitle" style="margin:4px 0 0;"></p>
      </div>
      <div class="feedback-list__controls">
        <select class="feedback-sort-select" id="feedback-sort-select">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
        <div class="feedback-view-toggle">
          <button type="button" class="feedback-view-toggle__btn" data-view="month">This Month</button>
          <button type="button" class="feedback-view-toggle__btn" data-view="all">All Time</button>
        </div>
      </div>
    </div>
    <div class="forecast-list" id="feedback-list"></div>
  `;

  const sortedOrders = [...orders].sort((a, b) =>
    sortOrder === "newest" ? b.ratedAtMillis - a.ratedAtMillis : a.ratedAtMillis - b.ratedAtMillis
  );

  section.querySelector(".forecast-section__title-text").textContent =
    currentView === "month" ? `Feedback — ${monthLabel}` : "Feedback — All Time";
  section.querySelector(".forecast-section__subtitle").textContent =
    sortedOrders.length === 0
      ? "No comments left for this period."
      : `${sortedOrders.length} rating${sortedOrders.length === 1 ? "" : "s"} shown, ${sortOrder === "newest" ? "newest" : "oldest"} first.`;

  section.querySelectorAll(".feedback-view-toggle__btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.view === currentView);
    btn.addEventListener("click", () => {
      currentView = btn.dataset.view;
      render();
    });
  });

  const sortSelect = section.querySelector("#feedback-sort-select");
  sortSelect.value = sortOrder;
  sortSelect.addEventListener("change", (event) => {
    sortOrder = event.target.value;
    render();
  });

  const list = section.querySelector("#feedback-list");
  sortedOrders.forEach((order) => list.appendChild(buildFeedbackRow(order)));

  return section;
}

function buildFeedbackRow(order) {
  const row = document.createElement("div");
  row.className = "feedback-item";

  const dateLabel = order.ratedAtMillis
    ? new Date(order.ratedAtMillis).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : "";

  row.innerHTML = `
    <div class="feedback-item__top">
      <strong class="feedback-item__name"></strong>
      <span class="feedback-item__stars"></span>
      <span class="feedback-item__date"></span>
    </div>
    <p class="feedback-item__comment"></p>
  `;

  row.querySelector(".feedback-item__name").textContent = order.customerName;
  row.querySelector(".feedback-item__stars").innerHTML = buildStars(order.rating);
  row.querySelector(".feedback-item__date").textContent = dateLabel;

  const commentEl = row.querySelector(".feedback-item__comment");
  if (order.feedback) {
    commentEl.textContent = order.feedback;
  } else {
    commentEl.textContent = "(No comment left)";
    commentEl.classList.add("feedback-item__comment--empty");
  }

  return row;
}

function buildStars(rating) {
  let html = "";
  for (let i = 1; i <= 5; i++) {
    html += i <= rating
      ? `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2.5L14.8 8.9L21.8 9.6L16.5 14.2L18 21.1L12 17.4L6 21.1L7.5 14.2L2.2 9.6L9.2 8.9L12 2.5Z"/></svg>`
      : `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2.5L14.8 8.9L21.8 9.6L16.5 14.2L18 21.1L12 17.4L6 21.1L7.5 14.2L2.2 9.6L9.2 8.9L12 2.5Z"/></svg>`;
  }
  return html;
}

function average(numbers) {
  if (numbers.length === 0) return 0;
  return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
}
