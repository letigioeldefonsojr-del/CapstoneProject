// sales-daily — Daily sales tally documents.

import { db } from "./firebase-config.js";
import { SUPABASE_ENABLED } from "./SupabaseConfig.js";
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

export function recordSaleTally(movements, when = new Date()) {
  // With Supabase the sale record and the stock log save the tally themselves.
  if (SUPABASE_ENABLED) return Promise.resolve();
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
