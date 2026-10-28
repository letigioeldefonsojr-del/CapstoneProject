// ====================================================================
// DAILY SALES TALLY
// ----------------------------------------------------------------
// One small document per day ("salesDaily/2026-10-28") holding how many
// units of each product were sold that day:
//   { date: "2026-10-28", units: { <productId>: 14, <productId>: 3 } }
//
// Stock Monitoring reads these (at most one document per day) instead of
// every individual sale line from the last 60 days, which would cost one
// database read per line.
//
// The tally is written AFTER a sale has been saved and is never part of
// the sale itself, so a problem here can never stop a checkout.
// ====================================================================
import { db } from "./firebase-config.js";
import { doc, setDoc, increment } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

export const SALES_DAILY_COLLECTION = "salesDaily";

const pad2 = (n) => String(n).padStart(2, "0");

// Local calendar day, e.g. "2026-10-28".
export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// Start of that local day, as milliseconds.
export function dayKeyToMillis(key, hour = 0) {
  const [y, m, d] = String(key).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1, hour, 0, 0, 0).getTime();
}

// Adds the units sold in one sale to today's tally. `movements` are entries
// with { productId, previousStock, newStock } (units sold = previous - new).
export function recordSaleTally(movements, when = new Date()) {
  const units = {};
  (movements || []).forEach((m) => {
    const sold = (m.previousStock ?? 0) - (m.newStock ?? 0);
    if (m.productId && sold > 0) units[m.productId] = (units[m.productId] || 0) + sold;
  });
  const ids = Object.keys(units);
  if (ids.length === 0) return Promise.resolve();

  const key = dayKey(when);
  const data = { date: key, units: {} };
  ids.forEach((id) => { data.units[id] = increment(units[id]); });

  return setDoc(doc(db, SALES_DAILY_COLLECTION, key), data, { merge: true })
    .catch((error) => console.error("Couldn't update the daily sales tally:", error));
}
