import { db } from "./firebase-config.js";
import {
  collection, query, where, getDocs, Timestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ====================================================================
// TOP CUSTOMERS (admin only, shown on the Sales page)
// ----------------------------------------------------------------
// Ranks customers by how many times they bought, counting BOTH
//  - online orders (delivered, which includes picked-up orders), and
//  - face-to-face sales at the cashier that the cashier attached a
//    customer to.
// A registered customer is the same person in both (matched by account
// id), so their online and in-store purchases add up. Walk-in names the
// cashier typed are listed too, by name. In-store sales with no customer
// attached can't be credited to anyone and are not counted here.
// Fully refunded in-store sales are left out.
// ====================================================================
const PERIODS = [
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 90 days", days: 90 },
  { key: "365", label: "Last 12 months", days: 365 },
  { key: "all", label: "All time", days: null }
];
const SHOW_LIMIT = 10;

let period = "all";
let showAll = false;
let searchText = "";
let ranked = [];
let el = null;

document.addEventListener("sidebar:ready", (event) => {
  if (event.detail.role !== "admin") return;
  el = document.getElementById("top-customers");
  if (!el) return;
  load();
});

function money(n) {
  return "₱" + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function load() {
  el.innerHTML = `<p class="forecast-loading">Loading top customers...</p>`;
  const p = PERIODS.find((x) => x.key === period);
  const since = p.days ? Timestamp.fromDate(new Date(Date.now() - p.days * 86400000)) : null;

  try {
    const orderQ = since
      ? query(collection(db, "orders"), where("status", "==", "delivered"), where("createdAt", ">=", since))
      : query(collection(db, "orders"), where("status", "==", "delivered"));
    const posQ = since
      ? query(collection(db, "posSales"), where("createdAt", ">=", since))
      : collection(db, "posSales");
    const [orders, pos] = await Promise.all([getDocs(orderQ), getDocs(posQ)]);

    const people = new Map();
    // The name shown is the one on the customer's most recent purchase.
    const touch = (key, name, kind, when) => {
      if (!people.has(key)) people.set(key, { key, name: "", nameAt: -1, kind, online: 0, store: 0, spent: 0, last: 0 });
      const person = people.get(key);
      if (name && name !== "—" && when >= person.nameAt) { person.name = name; person.nameAt = when; }
      return person;
    };

    orders.forEach((d) => {
      const o = d.data();
      const key = o.userId ? `u:${o.userId}` : (o.customerName ? `n:${String(o.customerName).trim().toLowerCase()}` : null);
      if (!key) return;
      const person = touch(key, o.customerName, o.userId ? "registered" : "walkin", o.createdAt?.toMillis?.() ?? 0);
      person.online += 1;
      person.spent += typeof o.total === "number" ? o.total : 0;
      person.last = Math.max(person.last, o.createdAt?.toMillis?.() ?? 0);
    });

    pos.forEach((d) => {
      const s = d.data();
      if (!s.customerName) return;
      if (s.refundStatus === "full") return;
      const key = s.customerId ? `u:${s.customerId}` : `n:${String(s.customerName).trim().toLowerCase()}`;
      const person = touch(key, s.customerName, s.customerId ? "registered" : "walkin", s.createdAt?.toMillis?.() ?? 0);
      const kept = typeof s.total === "number" ? Math.max(0, s.total - (typeof s.refundedTotal === "number" ? s.refundedTotal : 0)) : 0;
      person.store += 1;
      person.spent += kept;
      person.last = Math.max(person.last, s.createdAt?.toMillis?.() ?? 0);
    });

    ranked = [...people.values()]
      .map((x) => ({ ...x, count: x.online + x.store, name: x.name || "Customer" }))
      .sort((a, b) => b.count - a.count || b.spent - a.spent);
    render();
  } catch (error) {
    console.error("Couldn't load top customers:", error);
    el.innerHTML = `<div class="panel topcust"><p class="forecast-loading">Couldn't load top customers right now.</p></div>`;
  }
}

function render() {
  const needle = searchText.trim().toLowerCase();
  const searching = needle.length > 0;
  const pool = searching ? ranked.filter((c) => c.name.toLowerCase().includes(needle)) : ranked;
  const rankOf = new Map(ranked.map((c, i) => [c.key, i + 1]));
  const rows = searching || showAll ? pool : pool.slice(0, SHOW_LIMIT);
  const options = PERIODS.map((p) => `<option value="${p.key}"${p.key === period ? " selected" : ""}>${p.label}</option>`).join("");

  const list = rows.length === 0
    ? (searching ? `<p class="forecast-loading">No customer matching "${esc(searchText.trim())}" has a completed purchase in this period.</p>` : `<p class="forecast-loading">No customer purchases in this period yet. In-store sales only count once the cashier picks a customer on the sale.</p>`)
    : rows.map((c, i) => `
      <div class="topcust__row">
        <div class="topcust__rank">${rankOf.get(c.key)}</div>
        <div>
          <div class="topcust__name">${esc(c.name)}</div>
          <div class="topcust__meta">${c.kind === "registered" ? "Registered customer" : "Walk-in"} · last purchase ${c.last ? new Date(c.last).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—"}</div>
          <div class="topcust__pills">
            ${c.online ? `<span class="topcust__pill">Online: ${c.online}</span>` : ""}
            ${c.store ? `<span class="topcust__pill topcust__pill--store">In-store: ${c.store}</span>` : ""}
          </div>
        </div>
        <div class="topcust__nums">
          <div class="topcust__count">${c.count}<small>purchase${c.count === 1 ? "" : "s"}</small></div>
          <div class="topcust__spent">${money(c.spent)}</div>
        </div>
      </div>`).join("");

  el.innerHTML = `
    <section class="panel topcust">
      <div class="topcust__head">
        <h3 class="panel__title">Top Customers</h3>
        <select id="topcust-period" class="feedback-sort-select" aria-label="Period">${options}</select>
      </div>
      <p class="topcust__sub">Ranked by number of purchases, online and in-store combined. Ties are ordered by total spent.</p>
      <input type="search" id="topcust-search" class="topcust__search" placeholder="Search a customer by name" value="${esc(searchText)}" autocomplete="off">
      <div class="topcust__list">${list}</div>
      ${!searching && ranked.length > SHOW_LIMIT ? `<button type="button" class="btn-outline" id="topcust-more" style="margin-top:12px">${showAll ? "Show top 10 only" : `Show all ${ranked.length}`}</button>` : ""}
    </section>`;

  document.getElementById("topcust-period").addEventListener("change", (e) => { period = e.target.value; showAll = false; load(); });
  const box = document.getElementById("topcust-search");
  box.addEventListener("input", () => {
    searchText = box.value;
    const pos = box.selectionStart;
    render();
    const again = document.getElementById("topcust-search");
    again.focus();
    again.setSelectionRange(pos, pos);
  });
  document.getElementById("topcust-more")?.addEventListener("click", () => { showAll = !showAll; render(); });
}
