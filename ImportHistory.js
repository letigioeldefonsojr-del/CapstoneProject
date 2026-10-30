// ====================================================================
// ONE-TIME IMPORT: old Firebase sales history -> Supabase
// ----------------------------------------------------------------
// Reads posSales, posRefunds, stockMovements and salesDaily from Firestore
// (the signed-in admin's own access) and sends them in batches to the
// store function, which adds only what is not already there.
// Nothing is changed or deleted in Firebase.
// ====================================================================
import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  collection, doc, getDoc, getDocs, query, orderBy, startAfter, limit, documentId
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { importHistory } from "./SupabaseStore.js?v=20261030l";

const BATCH = 300;
const btn = document.getElementById("start-btn");
const statusEl = document.getElementById("status");
const table = document.getElementById("result");
const tbody = table.querySelector("tbody");

function say(text, kind = "") {
  statusEl.textContent = text;
  statusEl.dataset.kind = kind;
  statusEl.hidden = false;
}

// Firestore values -> plain JSON (timestamps become ISO text).
function plain(v) {
  if (v === null || v === undefined) return v;
  if (typeof v.toDate === "function") return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = plain(x);
    return out;
  }
  return v;
}

const COLLECTIONS = [
  { label: "Sales receipts", name: "posSales", key: "sales", map: (id, d) => ({ id, createdAt: d.createdAt, sale: d }) },
  { label: "Refunds", name: "posRefunds", key: "refunds", map: (id, d) => ({ id, saleId: d.saleId, createdAt: d.createdAt, refund: d }) },
  { label: "Stock history", name: "stockMovements", key: "movements", map: (id, d) => ({ id, ...d }) },
  { label: "Daily totals", name: "salesDaily", key: "daily", map: (id, d) => ({ day: d.date || id, units: d.units || {} }) }
];

async function copyCollection(spec, row) {
  let last = null;
  let found = 0;
  let copied = 0;
  for (;;) {
    const constraints = [orderBy(documentId()), limit(BATCH)];
    if (last) constraints.splice(1, 0, startAfter(last));
    const snap = await getDocs(query(collection(db, spec.name), ...constraints));
    if (snap.empty) break;
    const items = snap.docs.map((d) => spec.map(d.id, plain(d.data())));
    found += items.length;
    const res = await importHistory({ [spec.key]: items });
    copied += res.copied?.[spec.key] ?? 0;
    row.cells[1].textContent = found;
    row.cells[2].textContent = copied;
    row.cells[3].textContent = found - copied;
    say(`Copying ${spec.label.toLowerCase()}... ${found} read so far`);
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < BATCH) break;
  }
  return { found, copied };
}

async function run() {
  btn.disabled = true;
  tbody.replaceChildren();
  table.hidden = false;
  const rows = COLLECTIONS.map((spec) => {
    const tr = document.createElement("tr");
    [spec.label, "0", "0", "0"].forEach((t) => { const td = document.createElement("td"); td.textContent = t; tr.appendChild(td); });
    tbody.appendChild(tr);
    return tr;
  });
  try {
    for (let i = 0; i < COLLECTIONS.length; i++) await copyCollection(COLLECTIONS[i], rows[i]);
    say("Finished. Open the Sales page and check an earlier date range.", "ok");
  } catch (error) {
    console.error("Import stopped:", error);
    say(`Stopped: ${error.message || error}. Nothing is lost; run it again to continue.`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Run again";
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) { btn.textContent = "Please sign in as an admin first"; say("You are signed out. Sign in on the admin login page, then open this page again.", "error"); return; }
  let isAdmin = false;
  try { isAdmin = (await getDoc(doc(db, "admins", user.uid))).exists(); } catch { /* treated as not admin */ }
  if (!isAdmin) { btn.textContent = "Admins only"; say("Only an administrator can run this.", "error"); return; }
  statusEl.hidden = true;
  btn.textContent = "Start copying";
  btn.disabled = false;
  btn.onclick = run;
});
