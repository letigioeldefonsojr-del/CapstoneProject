// shop — Customer ordering site: sign in, browse, cart, checkout, order tracking.

import { auth, db } from "./firebase-config.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, GoogleAuthProvider, signInWithPopup, createUserWithEmailAndPassword, updateProfile, signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, onSnapshot, collection, query, where, orderBy, limit,
  getDocs, runTransaction, serverTimestamp, Timestamp, increment
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { rowToProduct } from "./SupabaseStore.js?v=20261029c";
import { SUPABASE_URL, SUPABASE_KEY } from "./SupabaseConfig.js";
import { guardCall } from "./LoginGuard.js?v=20261030d";

// ----------------------------- RULES COPIED FROM THE APP -----------------------------
const WHOLESALE_MIN = 6;
const PHONE_DOMAIN = "phone.almares328.app";
const STORE_BRANCHES = [
  { name: "Balete Relocation Site, Batangas City", lat: 13.81429633377636, lng: 121.06634036922742, delivery: true },
  { name: "Banaba East, Batangas City", lat: 13.8126, lng: 121.0670, delivery: false },
  { name: "Balagtas, Batangas City", lat: 13.7975, lng: 121.0709, delivery: false }
];
// Service area box for the map (approximate Batangas City).
const AREA = { minLat: 13.60, maxLat: 13.90, minLng: 120.90, maxLng: 121.20 };
const PSGC = { region: "040000000", regionName: "Region IV-A (CALABARZON)", province: "041000000", provinceName: "Batangas", city: "041005000", cityName: "Batangas City" };
const CANCEL_REASONS = [
  "Changed my mind", "Ordered by mistake", "Found a better price elsewhere",
  "Delivery is taking too long", "Item no longer needed", "Other (please specify)"
];
const ACTIVE_STATUSES = ["pending", "approved", "ready_for_pickup", "on_the_way"];
const STATUS_LABELS = {
  pending: "Pending", approved: "Approved", on_the_way: "On the way", ready_for_pickup: "Ready for pickup",
  delivered: "Delivered", cancelled: "Cancelled", rejected: "Rejected", undelivered: "Undelivered"
};

// ----------------------------- SMALL HELPERS -----------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const peso = (n) => `₱${Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v) => { if (v === null || v === undefined || v === "") return NaN; if (typeof v === "number") return v; const n = parseFloat(String(v).replace(/[^\d.\-]/g, "")); return Number.isFinite(n) ? n : NaN; };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_");

function toast(message, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("is-in"), 10);
  setTimeout(() => { el.classList.remove("is-in"); setTimeout(() => el.remove(), 250); }, 3600);
}

function openModal(html, { onClose, wide = false } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal${wide ? " modal--wide" : ""}" role="dialog" aria-modal="true">${html}</div>`;
  document.body.appendChild(overlay);
  document.body.classList.add("has-modal");
  const close = () => {
    overlay.remove();
    if (!document.querySelector(".modal-overlay")) document.body.classList.remove("has-modal");
    if (onClose) onClose();
  };
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });
  return { overlay, modal: overlay.firstElementChild, close };
}

async function storeCall(action, payload = {}) {
  const user = auth.currentUser;
  if (!user) throw new Error("not_signed_in");
  const res = await fetch(`${SUPABASE_URL}/functions/v1/store-api`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY, "x-firebase-token": await user.getIdToken() },
    body: JSON.stringify({ action, ...payload })
  });
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok || !data || data.error) {
    const err = new Error(data?.error || `http_${res.status}`);
    err.code = String(data?.error || "");
    throw err;
  }
  return data;
}

// ----------------------------- PRICING (same rules as the app) -----------------------------
function toMillis(v) {
  if (v == null) return null;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  if (typeof v.seconds === "number") return v.seconds * 1000;
  if (typeof v._seconds === "number") return v._seconds * 1000;
  return null;
}
function discountActive(p) {
  if (!(Number(p.discountPercent) > 0)) return false;
  const now = Date.now(), start = toMillis(p.discountStart), end = toMillis(p.discountEnd);
  return !(start != null && start > now) && !(end != null && end < now);
}
const variantName = (v) => v && (v.name || v.flavor || v.label);
const variantsOf = (p) => (Array.isArray(p.flavors) ? p.flavors.filter((v) => v && typeof v === "object") : []);
const findVariant = (p, name) => (name ? variantsOf(p).find((v) => variantName(v) === name) || null : null);

function regularUnit(p, v) {
  const base = num((v || p).price);
  if (!Number.isFinite(base)) return null;
  return discountActive(p) ? round2(base * (100 - Number(p.discountPercent)) / 100) : base;
}
function wholesaleUnit(p, v) {
  const w = num((v || p).wholesalePrice);
  return Number.isFinite(w) && w > 0 ? w : null;
}
function priceParts(p, v, qty) {
  const unit = regularUnit(p, v) ?? 0;
  const ws = wholesaleUnit(p, v);
  const groups = ws != null && qty >= WHOLESALE_MIN ? Math.floor(qty / WHOLESALE_MIN) : 0;
  const wsQty = groups * WHOLESALE_MIN;
  const retailQty = qty - wsQty;
  const wsTotal = round2(wsQty * (ws ?? 0));
  const retailTotal = round2(retailQty * unit);
  return { unit, ws, wsQty, retailQty, wsTotal, retailTotal, total: round2(wsTotal + retailTotal), regularTotal: round2(qty * unit) };
}
function stockOf(p, v) {
  const s = v ? v.stock : p.stockCount;
  return typeof s === "number" ? s : null; // null = untracked
}
function itemStatus(p, flavorName) {
  if (!p) return "gone";
  if (flavorName) {
    const v = findVariant(p, flavorName);
    if (!v) return "gone";
    if (v.available === false || stockOf(p, v) === 0) return "unavailable";
    return p.available === false ? "unavailable" : "available";
  }
  if (p.available === false || stockOf(p, null) === 0) return "unavailable";
  return "available";
}

function calcTable(parts) {
  const rows = [];
  if (parts.wsQty > 0) rows.push(`<div class="calc__row"><span>${parts.wsQty}</span><span>${peso(parts.ws)} <em>wholesale</em></span><span>${peso(parts.wsTotal)}</span></div>`);
  if (parts.retailQty > 0 || parts.wsQty === 0) rows.push(`<div class="calc__row"><span>${parts.retailQty}</span><span>${peso(parts.unit)}</span><span>${peso(parts.retailTotal)}</span></div>`);
  return `<div class="calc"><div class="calc__head"><span>Qty</span><span>Rate</span><span>Amount</span></div>${rows.join("")}</div>`;
}

// ----------------------------- DELIVERY (same rules as the app) -----------------------------
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (d) => d * Math.PI / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function feeForKm(km) { return km <= 2 ? 15 : km <= 5 ? 30 : km <= 10 ? 60 : 100; }
function deliveryQuote(lat, lng) {
  let best = null;
  for (const b of STORE_BRANCHES) {
    if (!b.delivery) continue;
    const m = distanceMeters(b.lat, b.lng, lat, lng);
    if (!best || m < best.meters) best = { branch: b, meters: m };
  }
  return best ? { fee: feeForKm(best.meters / 1000), distanceKm: best.meters / 1000, branchName: best.branch.name } : null;
}
const mapUrlFor = (lat, lng) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`;

// ----------------------------- STATE -----------------------------
const state = {
  user: null, profile: null, authReady: false,
  products: [], productsById: new Map(), catalogLoaded: false, catalogComplete: false, catalogLoading: null, cartReady: false, cartFresh: 0,
  cart: [], cartUnsub: null, selected: new Set(), selectionTouched: false,
  orders: [], ordersUnsub: null, history: [], historyLoaded: false,
  search: "", category: "All", shown: 48,
  fulfillment: "delivery", pickupBranch: STORE_BRANCHES[0].name, address: null, // {address, lat, lng}
  placing: false, profileUnsub: null
};

// ----------------------------- CATALOG -----------------------------
// Fast start: show cached products at once (or the first 100), then load the rest in the background.
const IDB_NAME = "almares_shop", IDB_STORE = "catalog";
const openDb = () => new Promise((res, rej) => {
  const r = indexedDB.open(IDB_NAME, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function cacheGet() {
  try {
    const db = await openDb();
    return await new Promise((res) => { const q = db.transaction(IDB_STORE).objectStore(IDB_STORE).get("rows"); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); });
  } catch { return null; }
}
async function cachePut(rows) {
  try { const db = await openDb(); db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).put({ rows, at: Date.now() }, "rows"); } catch { /* cache is optional */ }
}
let drawShopGrid = null;
function applyCatalog(list) {
  const sorted = [...list].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  state.products = sorted;
  sorted.forEach((p) => state.productsById.set(p.id, p));
  if (drawShopGrid && route().name === "shop") drawShopGrid();
}
function loadCatalog() {
  if (state.catalogLoading) return state.catalogLoading;
  state.catalogLoading = (async () => {
    let fromCache = false;
    if (!state.catalogLoaded) {
      const cached = await cacheGet();
      if (cached?.rows?.length) { applyCatalog(cached.rows); state.catalogLoaded = true; fromCache = true; }
    }
    const first = await storeCall("app_list_products", { offset: 0, limit: 100 });
    const all = (first.products || []).map(rowToProduct);
    if (!state.catalogLoaded) { applyCatalog(all); state.catalogLoaded = true; }
    let done = first.done === true || all.length === 0, offset = all.length;
    while (!done) {
      const waves = await Promise.all([0, 1, 2, 3].map((i) => storeCall("app_list_products", { offset: offset + i * 1000, limit: 1000 })));
      for (const w of waves) { all.push(...(w.products || []).map(rowToProduct)); if (w.done) done = true; }
      offset += 4000;
      if (!done && !fromCache && !state.catalogComplete) applyCatalog(all);
    }
    applyCatalog(all);
    state.catalogComplete = true;
    cachePut(all);
    if (drawShopGrid && route().name === "shop") drawShopGrid();
  })();
  state.catalogLoading.finally(() => { state.catalogLoading = null; });
  return state.catalogLoading;
}

// The cart and checkout only need their own products: fetch just those (fast), not the whole catalogue.
async function ensureProducts(ids) {
  const need = [...new Set(ids)];
  for (let i = 0; i < need.length; i += 200) {
    const chunk = need.slice(i, i + 200);
    const data = await storeCall("app_get_products", { ids: chunk });
    const got = new Set();
    (data.products || []).map(rowToProduct).forEach((p) => { state.productsById.set(p.id, p); got.add(p.id); });
    chunk.forEach((id) => { if (!got.has(id)) state.productsById.delete(id); });
  }
  state.cartReady = true;
  state.cartFresh = Date.now();
}
async function prepareCart() {
  const ids = state.cart.map((c) => c.productId);
  const stale = !state.cartReady || Date.now() - (state.cartFresh || 0) > 60000 || ids.some((id) => !state.productsById.has(id) && !state.cartMissing?.has(id));
  if (!stale || !ids.length) return;
  try { await ensureProducts(ids); } catch (e) { console.error("Couldn't refresh cart products:", e); state.cartFresh = Date.now(); }
  state.cartMissing = new Set(ids.filter((id) => !state.productsById.has(id)));
}

// ----------------------------- AUTH + PROFILE -----------------------------
function displayNameOf(user, profile) {
  return user?.displayName || profile?.fullName || (user?.email ? user.email.split("@")[0] : "") || "Guest";
}

function watchAccount(user) {
  state.profileUnsub?.();
  state.profileUnsub = onSnapshot(doc(db, "users", user.uid), (snap) => {
    state.profile = snap.exists() ? snap.data() : null;
    const until = state.profile?.suspendedUntil;
    if (until && until.toDate && until.toDate() > new Date()) {
      const reason = state.profile.suspensionReason;
      signOut(auth).then(() => openSuspended(reason, until.toDate()));
    }
  }, () => { /* profile unreadable; stay usable */ });
}

function startUserListeners(user) {
  state.cartUnsub?.();
  state.cartUnsub = onSnapshot(query(collection(db, "users", user.uid, "cart"), orderBy("updatedAt", "desc")), (snap) => {
    state.cart = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!state.selectionTouched) state.selected = new Set(state.cart.map((c) => c.id));
    else state.selected = new Set([...state.selected].filter((id) => state.cart.some((c) => c.id === id)));
    renderHeader();
    if (["cart", "checkout"].includes(route().name)) render();
  }, (e) => console.error("Cart listener failed:", e));

  state.ordersUnsub?.();
  state.ordersUnsub = onSnapshot(
    query(collection(db, "orders"), where("userId", "==", user.uid), where("status", "in", ACTIVE_STATUSES)),
    (snap) => {
      state.orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (["orders", "order"].includes(route().name)) render();
    },
    (e) => console.error("Orders listener failed:", e)
  );
  loadHistory();
}

function loadHistory() {
  state.historyUnsub?.();
  const since = Timestamp.fromDate(new Date(Date.now() - 30 * 86400000));
  state.historyUnsub = onSnapshot(
    query(collection(db, "orders"), where("userId", "==", state.user.uid), where("createdAt", ">=", since), orderBy("createdAt", "desc"), limit(100)),
    (snap) => {
      state.history = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      state.historyLoaded = true;
      if (["orders", "order"].includes(route().name)) render();
    },
    (e) => { console.error("Order history failed:", e); state.historyLoaded = true; if (["orders", "order"].includes(route().name)) render(); }
  );
}

function stopUserListeners() {
  state.cartUnsub?.(); state.ordersUnsub?.(); state.profileUnsub?.(); state.historyUnsub?.();
  state.cartUnsub = state.ordersUnsub = state.profileUnsub = state.historyUnsub = null;
  newChat(); chat.open = false;
  Object.assign(state, { cart: [], orders: [], history: [], historyLoaded: false, profile: null, selected: new Set(), selectionTouched: false, address: null });
}

onAuthStateChanged(auth, async (user) => {
  state.user = user;
  state.authReady = true;
  if (user) {
    watchAccount(user);
    startUserListeners(user);
    if (["login", "register"].includes(route().name)) location.hash = "#/";
  } else {
    stopUserListeners();
    if (!["login", "register"].includes(route().name)) location.hash = "#/login";
  }
  render();
});

// ----------------------------- ROUTER -----------------------------
function route() {
  const parts = (location.hash.replace(/^#\/?/, "") || "").split("/").filter(Boolean);
  const name = parts[0] || "shop";
  return { name, id: parts[1] || null };
}
window.addEventListener("hashchange", () => { window.scrollTo(0, 0); render(); });

function renderHeader() {
  const el = $("#site-header");
  if (!el) return;
  const signedIn = !!state.user;
  const cartCount = state.cart.reduce((n, c) => n + (Number(c.amount) || 0), 0);
  const r = route().name;
  el.innerHTML = `
    <div class="header__inner">
      <a class="brand" href="#/"><img src="Logo.png" alt="" class="brand__logo"><span>Almares 328</span></a>
      ${signedIn ? `
      <nav class="nav">
        <a href="#/" class="${r === "shop" ? "is-active" : ""}">Shop</a>
        <a href="#/orders" class="${["orders", "order"].includes(r) ? "is-active" : ""}">My Orders</a>
        <a href="#/cart" class="nav__cart ${["cart", "checkout"].includes(r) ? "is-active" : ""}">Cart${cartCount ? `<span class="badge">${cartCount}</span>` : ""}</a>
      </nav>
      <div class="header__user">
        <span class="header__name">${esc(displayNameOf(state.user, state.profile))}</span>
        <button type="button" class="btn btn--ghost btn--sm" id="logout-btn">Log out</button>
      </div>` : `<a class="btn btn--ghost btn--sm" href="Login">Staff login</a>`}
    </div>`;
  $("#logout-btn")?.addEventListener("click", () => signOut(auth));
}

function render() {
  renderHeader();
  renderChat();
  if (!state.authReady) { app.innerHTML = `<p class="center muted">Loading...</p>`; return; }
  const { name, id } = route();
  if (!state.user) return name === "register" ? renderRegister() : renderLogin();
  switch (name) {
    case "cart": return renderCart();
    case "checkout": return renderCheckout();
    case "orders": return renderOrders();
    case "order": return renderOrderDetails(id);
    default: return renderShop();
  }
}

// ----------------------------- LOGIN -----------------------------
function renderLogin() {
  app.innerHTML = `
    <section class="card auth">
      <h1>Welcome back</h1>
      <p class="muted">Sign in to order from Almares 328.</p>
      <form id="login-form" novalidate>
        <label class="field"><span>Mobile number or email</span><input id="login-id" autocomplete="username" placeholder="09171234567 or you@email.com"></label>
        <label class="field"><span>Password</span>
          <div class="pw"><input id="login-pw" type="password" autocomplete="current-password"><button type="button" class="pw__toggle" data-toggle="login-pw" aria-label="Show password">${EYE}</button></div>
        </label>
        <p class="form-error" id="login-error" hidden></p>
        <button class="btn btn--primary btn--block" type="submit">Log in</button>
      </form>
      <div class="or"><span>or</span></div>
      <button type="button" class="btn btn--outline btn--block btn--google" id="google-btn">${GOOGLE_SVG} Continue with Google</button>
      <p class="muted center">New here? <a href="#/register">Create an account</a></p>
    </section>`;
  wirePasswordToggles();
  $("#google-btn").addEventListener("click", googleSignIn);
  const prefill = new URLSearchParams(location.search).get("u");
  if (prefill) { $("#login-id").value = prefill; $("#login-pw").focus(); }
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#login-error"), btn = e.submitter || $("#login-form button[type=submit]");
    err.hidden = true;
    const input = $("#login-id").value.trim(), pw = $("#login-pw").value;
    if (!input || !pw) { err.textContent = "Enter your mobile number or email and your password."; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = "Logging in...";
    try {
      let email = input;
      if (!input.includes("@")) {
        const digits = input.replace(/\D/g, "");
        if (!/^09\d{9}$/.test(digits)) throw Object.assign(new Error("bad-mobile"), { code: "bad-mobile" });
        const found = await guardCall("customer_resolve", { mobile: digits });
        if (!found.found || !found.email) throw Object.assign(new Error("none"), { code: "mobile-not-found" });
        email = found.email;
      }
      const cred = await signInWithEmailAndPassword(auth, email, pw);
      const snap = await getDoc(doc(db, "users", cred.user.uid));
      const until = snap.exists() ? snap.data().suspendedUntil : null;
      if (until?.toDate && until.toDate() > new Date()) {
        const reason = snap.data().suspensionReason;
        await signOut(auth);
        openSuspended(reason, until.toDate());
      }
    } catch (error) {
      console.error("Login failed:", error);
      const code = error.code || error.message;
      err.textContent =
        code === "bad-mobile" ? "Enter a valid mobile number like 09171234567." :
        code === "mobile-not-found" ? "No account found for that mobile number." :
        ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"].includes(code) ? "Wrong email/mobile number or password." :
        code === "auth/too-many-requests" || code === "slow_down" ? "Too many attempts. Please wait a moment and try again." :
        "Couldn't log in. Please try again.";
      err.hidden = false;
    } finally { btn.disabled = false; btn.textContent = "Log in"; }
  });
}

function openSuspended(reason, until) {
  const { modal } = openModal(`
    <div class="modal__head"><h3>Account suspended</h3></div>
    <div class="modal__body"><p>Your account is suspended until <strong>${esc(until.toLocaleDateString())}</strong>.</p>${reason ? `<p class="muted">Reason: ${esc(reason)}</p>` : ""}</div>
    <div class="modal__foot"><button class="btn btn--primary" data-close>OK</button></div>`);
  return modal;
}

const GOOGLE_SVG = `<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.6H24v9.1h11.9c-.5 2.8-2.1 5.1-4.4 6.7v5.5h7.1c4.2-3.9 6.5-9.6 6.5-16.7z"/><path fill="#34A853" d="M24 46c6 0 11-2 14.6-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.5 2.1-5.8 0-10.7-3.9-12.4-9.2H4.3v5.7C7.9 41.6 15.4 46 24 46z"/><path fill="#FBBC05" d="M11.6 28c-.4-1.3-.7-2.7-.7-4.1s.3-2.8.7-4.1v-5.7H4.3C2.8 17.1 2 20.4 2 24s.8 6.9 2.3 9.9L11.6 28z"/><path fill="#EA4335" d="M24 10.8c3.3 0 6.2 1.1 8.5 3.3l6.4-6.4C35 4.1 30 2 24 2 15.4 2 7.9 6.4 4.3 14.1l7.3 5.7c1.7-5.2 6.6-9 12.4-9z"/></svg>`;
async function googleSignIn() {
  try {
    const result = await signInWithPopup(auth, new GoogleAuthProvider());
    const user = result.user;
    const ref = doc(db, "users", user.uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      const parts = (user.displayName || "").trim().split(/\s+/).filter(Boolean);
      const firstName = parts[0] || "";
      const lastName = parts.length > 1 ? parts[parts.length - 1] : "";
      await setDoc(ref, {
        firstName, middleInitial: "", lastName, fullName: user.displayName || user.email || "",
        mobileNumber: "", address: "", email: user.email || "", authEmail: user.email || "",
        signInMethod: "google", createdAt: serverTimestamp()
      });
    }
  } catch (error) {
    if (error.code === "auth/popup-closed-by-user" || error.code === "auth/cancelled-popup-request") return;
    console.error("Google sign-in failed:", error);
    toast(error.code === "auth/popup-blocked" ? "Your browser blocked the Google window. Allow pop-ups and try again." : "Couldn't sign in with Google. Please try again.", "error");
  }
}

const EYE = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2 12C4 7.5 7.8 5 12 5C16.2 5 20 7.5 22 12C20 16.5 16.2 19 12 19C7.8 19 4 16.5 2 12Z" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6"/></svg>`;
function wirePasswordToggles(root = document) {
  root.querySelectorAll("[data-toggle]").forEach((btn) => btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.toggle);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
    btn.classList.toggle("is-on", show);
  }));
}

// ----------------------------- REGISTER -----------------------------
let barangays = null;
async function loadBarangays() {
  if (barangays) return barangays;
  try {
    const res = await fetch(`https://psgc.gitlab.io/api/cities-municipalities/${PSGC.city}/barangays/`);
    const data = await res.json();
    barangays = data.map((b) => ({ code: b.code, name: b.name })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) { console.error("Couldn't load barangays:", e); barangays = []; }
  return barangays;
}

function renderRegister() {
  const pin = { lat: null, lng: null };
  app.innerHTML = `
    <section class="card auth auth--wide">
      <h1>Create your account</h1>
      <p class="muted">Delivery is available within Batangas City.</p>
      <form id="reg-form" novalidate>
        <div class="grid grid--3">
          <label class="field"><span>First name *</span><input id="r-first" autocomplete="given-name"></label>
          <label class="field"><span>Middle initial</span><input id="r-mi" maxlength="1"></label>
          <label class="field"><span>Last name *</span><input id="r-last" autocomplete="family-name"></label>
        </div>
        <div class="grid grid--2">
          <label class="field"><span>Mobile number *</span><input id="r-mobile" inputmode="numeric" maxlength="11" placeholder="09171234567" autocomplete="tel"></label>
          <label class="field"><span>Email (optional)</span><input id="r-email" type="email" autocomplete="email"></label>
        </div>
        <div class="grid grid--2">
          <label class="field"><span>Password * (8+ characters)</span>
            <div class="pw"><input id="r-pw" type="password" autocomplete="new-password"><button type="button" class="pw__toggle" data-toggle="r-pw" aria-label="Show password">${EYE}</button></div></label>
          <label class="field"><span>Confirm password *</span>
            <div class="pw"><input id="r-pw2" type="password" autocomplete="new-password"><button type="button" class="pw__toggle" data-toggle="r-pw2" aria-label="Show password">${EYE}</button></div></label>
        </div>
        <h2 class="section">Delivery address</h2>
        <div class="grid grid--3">
          <label class="field"><span>House / Lot no. *</span><input id="r-house"></label>
          <label class="field"><span>Street *</span><input id="r-street"></label>
          <label class="field"><span>Purok</span><input id="r-purok"></label>
        </div>
        <div class="grid grid--2">
          <label class="field"><span>Barangay *</span><select id="r-brgy"><option value="">Loading...</option></select></label>
          <label class="field"><span>Landmark</span><input id="r-landmark"></label>
        </div>
        <div class="pinbox">
          <div><strong>Map pin *</strong><p class="muted" id="r-pin-text">Pin your exact location so we can compute the delivery fee.</p></div>
          <button type="button" class="btn btn--outline" id="r-pin-btn">Pick on map</button>
        </div>
        <p class="form-error" id="reg-error" hidden></p>
        <button class="btn btn--primary btn--block" type="submit">Create account</button>
      </form>
      <div class="or"><span>or</span></div>
      <button type="button" class="btn btn--outline btn--block btn--google" id="google-btn">${GOOGLE_SVG} Sign up with Google</button>
      <p class="muted center">Already have an account? <a href="#/login">Log in</a></p>
    </section>`;
  wirePasswordToggles();
  $("#google-btn").addEventListener("click", googleSignIn);
  loadBarangays().then((list) => {
    const sel = $("#r-brgy");
    if (!sel) return;
    sel.innerHTML = `<option value="">Select barangay</option>` + list.map((b) => `<option value="${esc(b.code)}|${esc(b.name)}">${esc(b.name)}</option>`).join("");
  });
  $("#r-pin-btn").addEventListener("click", () => pickAddress(pin.lat ? pin : null, (picked) => {
    pin.lat = picked.lat; pin.lng = picked.lng;
    $("#r-pin-text").textContent = `Pinned: ${picked.address}`;
  }));

  $("#reg-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#reg-error"), btn = $("#reg-form button[type=submit]");
    const fail = (m) => { err.textContent = m; err.hidden = false; };
    err.hidden = true;
    const v = (id) => $(id).value.trim();
    const first = v("#r-first"), mi = v("#r-mi"), last = v("#r-last"), email = v("#r-email");
    const mobile = v("#r-mobile").replace(/\D/g, ""), pw = $("#r-pw").value;
    const house = v("#r-house"), street = v("#r-street"), purok = v("#r-purok"), landmark = v("#r-landmark");
    const [brgyCode, brgyName] = ($("#r-brgy").value || "").split("|");
    if (!first || !last) return fail("Enter your first and last name.");
    if (mi && !/^[A-Za-z]$/.test(mi)) return fail("Middle initial must be a single letter.");
    if (!/^09\d{9}$/.test(mobile)) return fail("Enter a valid mobile number like 09171234567.");
    if (email && !/^[\w.+-]+@([\w-]+\.)+[\w-]{2,}$/.test(email)) return fail("Enter a valid email address or leave it blank.");
    if (pw.length < 8) return fail("Password must be at least 8 characters.");
    if (pw !== $("#r-pw2").value) return fail("The passwords don't match.");
    if (!house || !street) return fail("Enter your house/lot number and street.");
    if (!brgyName) return fail("Please select your barangay.");
    if (pin.lat == null) return fail("Please tap “Pick on map” and pin your exact location.");

    btn.disabled = true; btn.textContent = "Creating account...";
    try {
      try {
        const taken = await guardCall("customer_taken", { email: email || undefined, mobile });
        if (taken.mobileTaken) return fail("That mobile number is already registered.");
        if (taken.emailTaken) return fail("That email is already registered.");
      } catch (checkError) { console.error("Taken check skipped:", checkError); }

      const authEmail = email || `${mobile}@${PHONE_DOMAIN}`;
      const fullName = [first, mi ? `${mi}.` : "", last].filter(Boolean).join(" ");
      const address = [house, street, purok ? `Purok ${purok}` : "", `Barangay ${brgyName}`, PSGC.cityName, PSGC.provinceName].filter(Boolean).join(", ");
      const cred = await createUserWithEmailAndPassword(auth, authEmail, pw);
      await updateProfile(cred.user, { displayName: fullName });
      await setDoc(doc(db, "users", cred.user.uid), {
        firstName: first, middleInitial: mi, lastName: last, fullName,
        mobileNumber: `+63${mobile.slice(1)}`, address, houseNo: house, street, purok,
        region: PSGC.regionName, regionCode: PSGC.region, province: PSGC.provinceName, provinceCode: PSGC.province,
        municipality: PSGC.cityName, municipalityCode: PSGC.city, barangay: brgyName, barangayCode: brgyCode,
        addressLat: pin.lat, addressLng: pin.lng, landmark, email, authEmail, createdAt: serverTimestamp()
      });
      toast("Account created. Welcome!", "success");
    } catch (error) {
      console.error("Sign-up failed:", error);
      fail(error.code === "auth/email-already-in-use" ? "That email or mobile number is already registered." :
        error.code === "auth/weak-password" ? "Choose a stronger password." : "Couldn't create the account. Please try again.");
    } finally { btn.disabled = false; btn.textContent = "Create account"; }
  });
}

// ----------------------------- ADDRESS PICKER -----------------------------
function pickAddress(initial, onPick) {
  const { overlay, modal, close } = openModal(`
    <div class="modal__head"><h3>Pin your location</h3><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="picker">
      <div class="picker__search">
        <input id="pk-q" placeholder="Search a place or address in Batangas City">
        <button type="button" class="btn btn--outline btn--sm" id="pk-go">Search</button>
        <button type="button" class="btn btn--outline btn--sm" id="pk-me">Use my location</button>
      </div>
      <div class="picker__results" id="pk-results" hidden></div>
      <div class="picker__map"><div id="pk-map"></div><div class="picker__pin" aria-hidden="true"></div></div>
      <p class="picker__label" id="pk-label">Move the map so the pin sits on your exact location.</p>
    </div>
    <div class="modal__foot"><button class="btn btn--outline" data-close>Cancel</button><button class="btn btn--primary" id="pk-ok" disabled>Use this location</button></div>`, { wide: true });

  if (!window.L) { toast("The map couldn't load. Check your connection and try again.", "error"); close(); return; }
  const start = initial?.lat != null ? [initial.lat, initial.lng] : [STORE_BRANCHES[0].lat, STORE_BRANCHES[0].lng];
  const map = L.map($("#pk-map", modal), {
    center: start, zoom: 16, minZoom: 11, maxZoom: 19,
    maxBounds: [[AREA.minLat, AREA.minLng], [AREA.maxLat, AREA.maxLng]], maxBoundsViscosity: 1
  });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors" }).addTo(map);
  setTimeout(() => map.invalidateSize(), 80);

  let label = "", timer = null, token = 0;
  const labelEl = $("#pk-label", modal), okBtn = $("#pk-ok", modal);
  async function reverse() {
    const my = ++token, c = map.getCenter();
    labelEl.textContent = "Finding address...";
    okBtn.disabled = true;
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&lat=${c.lat}&lon=${c.lng}`);
      const data = await res.json();
      if (my !== token) return;
      label = data.display_name || `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
    } catch { if (my !== token) return; label = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`; }
    labelEl.textContent = label;
    okBtn.disabled = false;
  }
  map.on("moveend", () => { clearTimeout(timer); timer = setTimeout(reverse, 700); });
  reverse();

  async function search() {
    const q = $("#pk-q", modal).value.trim();
    const box = $("#pk-results", modal);
    if (!q) return;
    box.hidden = false; box.innerHTML = `<p class="muted">Searching...</p>`;
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=ph&viewbox=${AREA.minLng},${AREA.maxLat},${AREA.maxLng},${AREA.minLat}&q=${encodeURIComponent(q)}`;
      const results = await (await fetch(url)).json();
      box.innerHTML = results.length ? results.map((r, i) => `<button type="button" data-i="${i}">${esc(r.display_name)}</button>`).join("") : `<p class="muted">No results. Try a nearby landmark.</p>`;
      box.onclick = (e) => {
        const b = e.target.closest("[data-i]");
        if (!b) return;
        const r = results[Number(b.dataset.i)];
        map.setView([Number(r.lat), Number(r.lon)], 17);
        box.hidden = true;
      };
    } catch { box.innerHTML = `<p class="muted">Search failed. Try again.</p>`; }
  }
  $("#pk-go", modal).addEventListener("click", search);
  $("#pk-q", modal).addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } });
  $("#pk-me", modal).addEventListener("click", () => {
    if (!navigator.geolocation) return toast("Location isn't available on this device.", "error");
    navigator.geolocation.getCurrentPosition(
      (p) => map.setView([p.coords.latitude, p.coords.longitude], 17),
      () => toast("Couldn't get your location. You can drag the map instead.", "error"),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
  okBtn.addEventListener("click", () => {
    const c = map.getCenter();
    onPick({ address: label, lat: Number(c.lat.toFixed(6)), lng: Number(c.lng.toFixed(6)) });
    close();
  });
}

// ----------------------------- SHOP -----------------------------
function categoriesOf() {
  const set = new Set(state.products.map((p) => p.category).filter(Boolean));
  return ["All", ...[...set].sort((a, b) => String(a).localeCompare(String(b)))];
}
function filteredProducts() {
  const q = state.search.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  return state.products.filter((p) => {
    if (state.category !== "All" && p.category !== state.category) return false;
    if (!tokens.length) return true;
    const hay = `${p.name} ${p.category || ""} ${variantsOf(p).map(variantName).join(" ")}`.toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}
function cardPrice(p) {
  const vs = variantsOf(p);
  const units = (vs.length ? vs.map((v) => regularUnit(p, v)) : [regularUnit(p, null)]).filter((n) => n != null);
  if (!units.length) return `<span class="muted">No price</span>`;
  const min = Math.min(...units), max = Math.max(...units);
  const wsList = (vs.length ? vs.map((v) => wholesaleUnit(p, v)) : [wholesaleUnit(p, null)]).filter((n) => n != null);
  return `<strong>${peso(min)}${max > min ? "+" : ""}</strong>${discountActive(p) ? ` <em class="tag tag--sale">−${Number(p.discountPercent)}%</em>` : ""}
    ${wsList.length ? `<span class="muted small">${peso(Math.min(...wsList))} each for ${WHOLESALE_MIN}+</span>` : ""}`;
}
function productCardHtml(p) {
  const vs = variantsOf(p);
  const anyAvail = vs.length ? vs.some((v) => itemStatus(p, variantName(v)) === "available") : itemStatus(p, null) === "available";
  return `
    <article class="product ${anyAvail ? "" : "is-out"}">
      <div class="product__img">${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span>${esc(String(p.name || "?").charAt(0))}</span>`}</div>
      <h3 class="product__name">${esc(p.name)}</h3>
      <div class="product__price">${cardPrice(p)}</div>
      <button type="button" class="btn btn--primary btn--sm btn--block" data-add="${esc(p.id)}" ${anyAvail ? "" : "disabled"}>${anyAvail ? "Add to cart" : "Out of stock"}</button>
    </article>`;
}

function renderShop() {
  app.innerHTML = `
    <section class="hero"><div><h1>Fresh groceries, delivered</h1><p>Order from Almares 328 and pick up in store or get it delivered in Batangas City.</p></div></section>
    <section class="shop">
      <div class="shop__bar">
        <input id="shop-q" type="search" placeholder="Search products..." value="${esc(state.search)}" autocomplete="off">
        <select id="shop-cat" aria-label="Category"></select>
      </div>
      <p class="muted small" id="shop-status" hidden>Loading more products...</p>
      <div id="shop-grid" class="grid-products"><p class="muted center">Loading products...</p></div>
      <div class="center"><button type="button" class="btn btn--outline" id="shop-more" hidden>Show more</button></div>
    </section>`;
  const draw = () => {
    const grid = $("#shop-grid");
    if (!grid) return;
    const cats = categoriesOf();
    const sel = $("#shop-cat");
    if (sel && sel.options.length !== cats.length) sel.innerHTML = cats.map((c) => `<option ${c === state.category ? "selected" : ""}>${esc(c)}</option>`).join("");
    const list = filteredProducts();
    grid.innerHTML = list.length ? list.slice(0, state.shown).map(productCardHtml).join("") : `<p class="muted center">${state.catalogComplete ? "No products found." : "Loading products..."}</p>`;
    const more = $("#shop-more");
    more.hidden = list.length <= state.shown;
    more.textContent = `Show more (${list.length - state.shown} left)`;
    $("#shop-status").hidden = state.catalogComplete;
  };
  drawShopGrid = draw;
  $("#shop-q").addEventListener("input", (e) => { state.search = e.target.value; state.shown = 48; draw(); });
  $("#shop-cat").addEventListener("change", (e) => { state.category = e.target.value; state.shown = 48; draw(); });
  $("#shop-more").addEventListener("click", () => { state.shown += 48; draw(); });
  $("#shop-grid").addEventListener("click", (e) => {
    const b = e.target.closest("[data-add]");
    if (b) openProduct(b.dataset.add);
  });
  if (state.catalogLoaded) draw();
  loadCatalog().then(() => { if (route().name === "shop") draw(); }).catch((e) => {
    console.error("Couldn't load products:", e);
    if (!state.catalogLoaded && $("#shop-grid")) {
      $("#shop-grid").innerHTML = `<p class="center muted">Couldn't load products. <button class="btn btn--outline btn--sm" id="retry">Try again</button></p>`;
      $("#retry")?.addEventListener("click", renderShop);
    }
  });
}

function openProduct(id) {
  const p = state.productsById.get(id);
  if (!p) return;
  const vs = variantsOf(p);
  let flavor = vs.length ? (vs.map(variantName).find((n) => itemStatus(p, n) === "available") || null) : null;
  let qty = 1;
  const { modal, close } = openModal(`<div id="po-body"></div>`);

  const draw = () => {
    const v = flavor ? findVariant(p, flavor) : null;
    const stock = stockOf(p, v);
    const max = Math.min(stock ?? 500, 500);
    if (qty > max) qty = Math.max(1, max);
    const parts = priceParts(p, v, qty);
    const status = itemStatus(p, flavor);
    $("#po-body", modal).innerHTML = `
      <div class="modal__head"><h3>${esc(p.name)}</h3><button class="icon-btn" data-close aria-label="Close">✕</button></div>
      <div class="modal__body">
        ${p.imageUrl ? `<img class="po__img" src="${esc(p.imageUrl)}" alt="" referrerpolicy="no-referrer">` : ""}
        ${vs.length ? `<div class="chips" role="radiogroup">${vs.map((x) => {
          const n = variantName(x), st = itemStatus(p, n);
          return `<button type="button" class="chip ${n === flavor ? "is-on" : ""}" data-flavor="${esc(n)}" ${st !== "available" ? "disabled" : ""}>${esc(n)}${st !== "available" ? " (out)" : ""}</button>`;
        }).join("")}</div>` : ""}
        <div class="po__row">
          <div class="qty"><button type="button" data-q="-1" aria-label="Less">−</button><input id="po-qty" type="number" min="1" max="${max}" value="${qty}" inputmode="numeric"><button type="button" data-q="1" aria-label="More">+</button></div>
          <span class="muted small">${stock != null ? `${stock} in stock` : "In stock"}</span>
        </div>
        ${calcTable(parts)}
        ${parts.ws != null && parts.wsQty === 0 ? `<p class="muted small">Buy ${WHOLESALE_MIN}+ to get ${peso(parts.ws)} each on every full ${WHOLESALE_MIN}.</p>` : ""}
        <div class="po__total"><span>Total</span><strong>${peso(parts.total)}</strong></div>
      </div>
      <div class="modal__foot"><button class="btn btn--primary btn--block" id="po-add" ${status === "available" ? "" : "disabled"}>Add to cart</button></div>`;
  };
  draw();
  modal.addEventListener("click", (e) => {
    const f = e.target.closest("[data-flavor]");
    if (f) { flavor = f.dataset.flavor; qty = 1; draw(); return; }
    const q = e.target.closest("[data-q]");
    if (q) { qty = Math.max(1, qty + Number(q.dataset.q)); draw(); return; }
    if (e.target.closest("#po-add")) addToCart(p, flavor, qty).then((ok) => { if (ok) close(); });
  });
  modal.addEventListener("change", (e) => {
    if (e.target.id === "po-qty") { qty = Math.max(1, Math.floor(Number(e.target.value) || 1)); draw(); }
  });
}

async function addToCart(p, flavor, qty) {
  if (vsRequired(p) && !flavor) { toast("Please choose an option.", "error"); return false; }
  const v = flavor ? findVariant(p, flavor) : null;
  const unit = regularUnit(p, v);
  if (unit == null) { toast("This item has no price yet.", "error"); return false; }
  const ws = wholesaleUnit(p, v);
  const docId = slug(`${p.name}-${flavor || "default"}`);
  const inCart = state.cart.find((c) => c.id === docId);
  const stock = stockOf(p, v);
  if (stock != null && (inCart?.amount || 0) + qty > stock) { toast(`Only ${stock} in stock (you have ${inCart?.amount || 0} in your cart).`, "error"); return false; }
  try {
    await setDoc(doc(db, "users", state.user.uid, "cart", docId), {
      productId: p.id, productName: p.name, imageUrl: p.imageUrl || null, flavor: flavor || null,
      unitPrice: unit, wholesalePrice: ws != null ? peso(ws).replace(/,/g, "") : null,
      amount: increment(qty), updatedAt: serverTimestamp()
    }, { merge: true });
    toast("Added to cart", "success");
    return true;
  } catch (e) { console.error("Add to cart failed:", e); toast("Couldn't add to cart. Try again.", "error"); return false; }
}
const vsRequired = (p) => variantsOf(p).length > 0;

// ----------------------------- CART -----------------------------
function cartLines() {
  return state.cart.map((c) => {
    const p = state.productsById.get(c.productId);
    const v = p && c.flavor ? findVariant(p, c.flavor) : null;
    const status = state.cartReady ? itemStatus(p, c.flavor) : "available";
    const qty = Math.max(1, Math.floor(Number(c.amount) || 1));
    const parts = p ? priceParts(p, v, qty) : priceParts({ price: c.unitPrice, wholesalePrice: num(c.wholesalePrice) || null }, null, qty);
    return { c, p, v, status, qty, parts, stock: p ? stockOf(p, v) : null };
  });
}

async function renderCart() {
  if (!state.cartReady) app.innerHTML = `<p class="center muted">Loading your cart...</p>`;
  await prepareCart();
  if (route().name !== "cart") return;
  const lines = cartLines();
  if (!lines.length) {
    app.innerHTML = `<section class="card center"><h1>Your cart is empty</h1><p class="muted">Add some products to get started.</p><a class="btn btn--primary" href="#/">Browse products</a></section>`;
    return;
  }
  const chosen = lines.filter((l) => l.status === "available" && state.selected.has(l.c.id));
  const subtotal = round2(chosen.reduce((s, l) => s + l.parts.regularTotal, 0));
  const total = round2(chosen.reduce((s, l) => s + l.parts.total, 0));
  const discount = round2(subtotal - total);
  app.innerHTML = `
    <section class="cart">
      <h1>Your cart</h1>
      <div class="cart__list">
        ${lines.map((l) => `
          <article class="cartline ${l.status !== "available" ? "is-out" : ""}">
            <label class="cartline__check"><input type="checkbox" data-sel="${esc(l.c.id)}" ${state.selected.has(l.c.id) && l.status === "available" ? "checked" : ""} ${l.status !== "available" ? "disabled" : ""}></label>
            <div class="cartline__img">${l.c.imageUrl ? `<img src="${esc(l.c.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span>${esc(String(l.c.productName || "?").charAt(0))}</span>`}</div>
            <div class="cartline__main">
              <h3>${esc(l.c.productName)}${l.c.flavor ? ` <span class="muted">· ${esc(l.c.flavor)}</span>` : ""}</h3>
              ${l.status === "gone" ? `<p class="form-error">No longer available</p>` : l.status === "unavailable" ? `<p class="form-error">Out of stock</p>` : `
                <div class="qty"><button type="button" data-dec="${esc(l.c.id)}" aria-label="Less">−</button><input type="number" min="1" ${l.stock != null ? `max="${l.stock}"` : ""} value="${l.qty}" data-qty="${esc(l.c.id)}" inputmode="numeric"><button type="button" data-inc="${esc(l.c.id)}" aria-label="More">+</button></div>
                ${calcTable(l.parts)}`}
            </div>
            <div class="cartline__side"><strong>${l.status === "available" ? peso(l.parts.total) : ""}</strong><button type="button" class="link-btn" data-rm="${esc(l.c.id)}">Remove</button></div>
          </article>`).join("")}
      </div>
      <aside class="card summary">
        <div class="summary__row"><span>Items</span><span>${chosen.reduce((n, l) => n + l.qty, 0)}</span></div>
        <div class="summary__row"><span>Subtotal</span><span>${peso(subtotal)}</span></div>
        ${discount > 0 ? `<div class="summary__row summary__row--good"><span>Wholesale discount</span><span>−${peso(discount)}</span></div>` : ""}
        <div class="summary__row summary__row--total"><span>Total</span><span>${peso(total)}</span></div>
        <p class="muted small">Delivery fee is added at checkout.</p>
        <button class="btn btn--primary btn--block" id="go-checkout" ${chosen.length ? "" : "disabled"}>Checkout</button>
      </aside>
    </section>`;
  const cartRef = (id) => doc(db, "users", state.user.uid, "cart", id);
  app.onclick = async (e) => {
    const t = e.target;
    if (t.matches("[data-sel]")) { state.selectionTouched = true; t.checked ? state.selected.add(t.dataset.sel) : state.selected.delete(t.dataset.sel); renderCart(); return; }
    const rm = t.closest("[data-rm]");
    if (rm) { await deleteDoc(cartRef(rm.dataset.rm)).catch(() => toast("Couldn't remove the item.", "error")); return; }
    const step = t.closest("[data-inc],[data-dec]");
    if (step) {
      const id = step.dataset.inc || step.dataset.dec, line = lines.find((l) => l.c.id === id);
      const next = line.qty + (step.dataset.inc ? 1 : -1);
      if (next < 1) return;
      if (line.stock != null && next > line.stock) return toast(`Only ${line.stock} in stock.`, "error");
      await updateDoc(cartRef(id), { amount: next, updatedAt: serverTimestamp() }).catch(() => toast("Couldn't update the quantity.", "error"));
      return;
    }
    if (t.id === "go-checkout") location.hash = "#/checkout";
  };
  app.onchange = async (e) => {
    const t = e.target;
    if (!t.matches("[data-qty]")) return;
    const line = lines.find((l) => l.c.id === t.dataset.qty);
    let next = Math.max(1, Math.floor(Number(t.value) || 1));
    if (line.stock != null && next > line.stock) { next = line.stock; toast(`Only ${line.stock} in stock.`, "error"); }
    await updateDoc(cartRef(t.dataset.qty), { amount: next, updatedAt: serverTimestamp() }).catch(() => toast("Couldn't update the quantity.", "error"));
  };
}

// ----------------------------- CHECKOUT -----------------------------
function currentAddress() {
  if (state.address) return state.address;
  const pr = state.profile;
  if (pr?.address && pr.addressLat != null && pr.addressLng != null) return { address: pr.address, lat: pr.addressLat, lng: pr.addressLng };
  if (pr?.address) return { address: pr.address, lat: null, lng: null };
  return null;
}

async function renderCheckout() {
  if (!state.cartReady) app.innerHTML = `<p class="center muted">Loading...</p>`;
  await prepareCart();
  if (route().name !== "checkout") return;
  const lines = cartLines().filter((l) => l.status === "available" && state.selected.has(l.c.id));
  if (!lines.length) { location.hash = "#/cart"; return; }
  const isPickup = state.fulfillment === "pickup";
  const addr = currentAddress();
  const quote = !isPickup && addr?.lat != null ? deliveryQuote(addr.lat, addr.lng) : null;
  const itemsSubtotal = round2(lines.reduce((s, l) => s + l.parts.total, 0));
  const regular = round2(lines.reduce((s, l) => s + l.parts.regularTotal, 0));
  const fee = isPickup ? 0 : (quote ? quote.fee : 0);
  const total = round2(itemsSubtotal + fee);

  app.innerHTML = `
    <section class="checkout">
      <h1>Checkout</h1>
      <div class="checkout__grid">
        <div>
          <div class="card">
            <h2 class="section">How would you like your order?</h2>
            <div class="seg" role="tablist">
              <button type="button" class="${!isPickup ? "is-on" : ""}" data-ful="delivery">Delivery</button>
              <button type="button" class="${isPickup ? "is-on" : ""}" data-ful="pickup">Pick up in store</button>
            </div>
            ${isPickup ? `
              <label class="field"><span>Pick-up branch</span><select id="co-branch">${STORE_BRANCHES.map((b) => `<option ${b.name === state.pickupBranch ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</select></label>`
            : `
              <div class="addr">
                <div><strong>Deliver to</strong><p>${addr ? esc(addr.address) : "No address yet"}</p>
                ${addr && addr.lat == null ? `<p class="form-error">Pin your location on the map so we can compute the fee.</p>` : ""}</div>
                <button type="button" class="btn btn--outline btn--sm" id="co-change">${addr ? "Change address" : "Choose address"}</button>
              </div>
              ${quote ? `<p class="muted small">Distance ${quote.distanceKm.toFixed(1)} km from ${esc(quote.branchName)}</p>` : addr?.lat != null ? `<p class="muted small">Fee to be confirmed by the store.</p>` : ""}`}
          </div>
          <div class="card">
            <h2 class="section">Items</h2>
            ${lines.map((l) => `
              <div class="coline">
                <div><strong>${esc(l.c.productName)}</strong>${l.c.flavor ? ` <span class="muted">· ${esc(l.c.flavor)}</span>` : ""}${calcTable(l.parts)}</div>
                <strong>${peso(l.parts.total)}</strong>
              </div>`).join("")}
          </div>
        </div>
        <aside class="card summary">
          <div class="summary__row"><span>Items</span><span>${lines.reduce((n, l) => n + l.qty, 0)}</span></div>
          <div class="summary__row"><span>Subtotal</span><span>${peso(regular)}</span></div>
          ${regular - itemsSubtotal > 0.004 ? `<div class="summary__row summary__row--good"><span>Wholesale discount</span><span>−${peso(round2(regular - itemsSubtotal))}</span></div>` : ""}
          <div class="summary__row"><span>${isPickup ? "Pick-up" : "Delivery fee"}</span><span>${isPickup ? "Free" : quote ? peso(fee) : "To be confirmed"}</span></div>
          <div class="summary__row summary__row--total"><span>Total</span><span>${peso(total)}</span></div>
          <p class="muted small">${isPickup ? "Pay in the store when you pick up your order." : "Pay when your order is delivered."} Delivery takes about 3 days.</p>
          <button class="btn btn--primary btn--block" id="co-confirm" ${state.placing ? "disabled" : ""}>${state.placing ? "Placing order..." : "Confirm order"}</button>
          <a class="btn btn--ghost btn--block" href="#/cart">Back to cart</a>
        </aside>
      </div>
    </section>`;
  app.onclick = (e) => {
    const f = e.target.closest("[data-ful]");
    if (f) { state.fulfillment = f.dataset.ful; renderCheckout(); return; }
    if (e.target.closest("#co-change")) {
      const a = currentAddress();
      pickAddress(a?.lat != null ? a : null, (picked) => { state.address = picked; renderCheckout(); });
      return;
    }
    if (e.target.closest("#co-confirm")) placeOrder(lines, { isPickup, addr, quote, itemsSubtotal, fee });
  };
  app.onchange = (e) => { if (e.target.id === "co-branch") state.pickupBranch = e.target.value; };
}

async function placeOrder(lines, { isPickup, addr, quote, fee }) {
  if (state.placing) return;
  if (!isPickup && !addr?.address?.trim()) return toast("Please choose a delivery address before confirming.", "error");
  state.placing = true;
  $("#co-confirm").disabled = true; $("#co-confirm").textContent = "Placing order...";
  const user = state.user;
  const orderRef = doc(collection(db, "orders"));
  let stockTaken = false;
  const checkoutItems = lines.map((l) => ({ id: l.c.productId, variant: l.c.flavor || null, qty: l.qty }));
  try {
    // Fresh prices, right before the order is placed.
    const fresh = await storeCall("app_get_products", { ids: [...new Set(checkoutItems.map((i) => i.id))] });
    const freshById = new Map((fresh.products || []).map(rowToProduct).map((p) => [p.id, p]));
    const priced = lines.map((l) => {
      const p = freshById.get(l.c.productId);
      if (!p || itemStatus(p, l.c.flavor) === "gone") throw Object.assign(new Error("gone"), { code: "gone", name: l.c.productName });
      const parts = priceParts(p, l.c.flavor ? findVariant(p, l.c.flavor) : null, l.qty);
      return { l, parts };
    });

    await storeCall("app_apply_sale", { items: checkoutItems, ref: orderRef.id });
    stockTaken = true;

    const orderItems = priced.map(({ l, parts }) => {
      const unitPrice = l.qty > 0 ? parts.total / l.qty : 0;
      return {
        productId: l.c.productId, productName: l.c.productName, imageUrl: l.c.imageUrl || null, flavor: l.c.flavor || null,
        amount: l.qty, unitPrice, subtotal: round2(unitPrice * l.qty)
      };
    });
    const itemsSubtotal = round2(orderItems.reduce((s, i) => s + i.subtotal, 0));
    const name = displayNameOf(user, state.profile);
    const doc_ = {
      userId: user.uid, customerName: name, customerAddress: isPickup ? "" : addr.address,
      items: orderItems, itemCount: orderItems.length, itemsSubtotal, deliveryFee: isPickup ? 0 : fee,
      fulfillmentType: isPickup ? "pickup" : "delivery",
      ...(isPickup ? { pickupBranch: state.pickupBranch }
        : quote ? { deliveryDistanceKm: quote.distanceKm, deliveryBranch: quote.branchName } : { deliveryFeeUnresolved: true }),
      ...(!isPickup && addr.lat != null ? { deliveryLat: addr.lat, deliveryLng: addr.lng, deliveryMapUrl: mapUrlFor(addr.lat, addr.lng) } : {}),
      total: round2(itemsSubtotal + (isPickup ? 0 : fee)),
      status: "pending",
      estimatedDelivery: Timestamp.fromDate(new Date(Date.now() + 3 * 86400000)),
      createdAt: serverTimestamp()
    };
    await runTransaction(db, async (txn) => {
      lines.forEach((l) => txn.delete(doc(db, "users", user.uid, "cart", l.c.id)));
      txn.set(orderRef, doc_);
    });
    storeCall("app_notify_staff", {
      message: isPickup ? `New PICKUP order from ${name} (${state.pickupBranch}) — ₱${doc_.total.toFixed(2)}` : `New order from ${name} — ₱${doc_.total.toFixed(2)}`,
      orderId: orderRef.id
    }).catch((e) => console.error("Staff notice failed:", e));
    state.selectionTouched = false;
    toast("Order placed! The store will review it shortly.", "success");
    state.placing = false;
    location.hash = `#/order/${orderRef.id}`;
  } catch (error) {
    console.error("Placing the order failed:", error);
    if (stockTaken) storeCall("app_restock", { items: checkoutItems, ref: orderRef.id }).catch((e) => console.error("Restock failed:", e));
    state.placing = false;
    const code = String(error.code || error.message || "");
    toast(
      error.code === "gone" ? `${error.name} is no longer available. Please update your cart.` :
      /insufficient/i.test(code) ? "Some items don't have enough stock any more. Please check your cart." :
      code === "too_many_orders" ? "Too many orders in a short time. Please try again later." :
      "Couldn't place your order. Please try again.", "error");
    if (route().name === "checkout") renderCheckout();
  }
}

// ----------------------------- ORDERS -----------------------------
function allOrders() {
  const byId = new Map();
  [...state.history, ...state.orders].forEach((o) => byId.set(o.id, { ...byId.get(o.id), ...o }));
  return [...byId.values()].sort((a, b) => (b.createdAt?.seconds ?? Infinity) - (a.createdAt?.seconds ?? Infinity));
}
const statusLabel = (o) => (o.status === "delivered" && o.fulfillmentType === "pickup" ? "Picked up" : STATUS_LABELS[o.status] || o.status);
const dateOf = (t) => (t?.toDate ? t.toDate().toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "Just now");

function renderOrders() {
  const list = allOrders();
  app.innerHTML = `
    <section>
      <h1>My orders</h1>
      ${!state.historyLoaded && !list.length ? `<p class="muted center">Loading...</p>` :
        list.length ? `<div class="orders">${list.map((o) => `
          <a class="card order" href="#/order/${esc(o.id)}">
            <div class="order__top"><strong>Order #${esc(o.id.slice(0, 6).toUpperCase())}</strong><span class="pill pill--${esc(o.status)}">${esc(statusLabel(o))}</span></div>
            <p class="muted small">${esc(dateOf(o.createdAt))} · ${o.fulfillmentType === "pickup" ? "Pick-up" : "Delivery"} · ${Number(o.itemCount) || (o.items || []).length} item(s)</p>
            <p class="order__total">${peso(o.total)}</p>
          </a>`).join("")}</div>` :
        `<div class="card center"><p class="muted">You haven't placed an order in the last 30 days.</p><a class="btn btn--primary" href="#/">Start shopping</a></div>`}
    </section>`;
}

const STEPS_DELIVERY = ["pending", "approved", "on_the_way", "delivered"];
const STEPS_PICKUP = ["pending", "approved", "ready_for_pickup", "delivered"];

async function renderOrderDetails(id) {
  let o = allOrders().find((x) => x.id === id);
  if (!o) {
    app.innerHTML = `<p class="center muted">Loading order...</p>`;
    try {
      const snap = await getDoc(doc(db, "orders", id));
      if (snap.exists() && snap.data().userId === state.user.uid) { o = { id, ...snap.data() }; state.history.unshift(o); }
    } catch (e) { console.error(e); }
    if (route().name !== "order") return;
  }
  if (!o) { app.innerHTML = `<section class="card center"><h1>Order not found</h1><a class="btn btn--primary" href="#/orders">Back to orders</a></section>`; return; }
  const pickup = o.fulfillmentType === "pickup";
  const steps = pickup ? STEPS_PICKUP : STEPS_DELIVERY;
  const off = ["cancelled", "rejected", "undelivered"].includes(o.status);
  const idx = steps.indexOf(o.status);
  app.innerHTML = `
    <section class="orderdetail">
      <a href="#/orders" class="link-btn">← My orders</a>
      <div class="order__top"><h1>Order #${esc(o.id.slice(0, 6).toUpperCase())}</h1><span class="pill pill--${esc(o.status)}">${esc(statusLabel(o))}</span></div>
      <p class="muted">${esc(dateOf(o.createdAt))}</p>
      ${off ? `<div class="card notice">${esc(STATUS_LABELS[o.status])}${o.cancelReason ? `: ${esc(o.cancelReason)}` : ""}${o.rejectReason ? `: ${esc(o.rejectReason)}` : ""}${o.deliveryIssueReason ? `: ${esc(o.deliveryIssueReason)}` : ""}</div>` :
        `<ol class="steps">${steps.map((s, i) => `<li class="${i <= idx ? "is-done" : ""}">${esc(s === "delivered" && pickup ? "Picked up" : STATUS_LABELS[s])}</li>`).join("")}</ol>`}
      <div class="card">
        <h2 class="section">${pickup ? "Pick-up" : "Delivery"}</h2>
        ${pickup ? `<p>${esc(o.pickupBranch || "Store")}</p>` : `<p>${esc(o.customerAddress || "")}</p>${o.deliveryMapUrl ? `<p><a href="${esc(o.deliveryMapUrl)}" target="_blank" rel="noopener">View on map</a></p>` : ""}${o.driverName ? `<p class="muted">Rider: ${esc(o.driverName)}</p>` : ""}`}
        ${!pickup && o.estimatedDelivery?.toDate && !off && o.status !== "delivered" ? `<p class="muted small">Estimated delivery: ${esc(o.estimatedDelivery.toDate().toLocaleDateString("en-PH", { dateStyle: "medium" }))}</p>` : ""}
      </div>
      <div class="card">
        <h2 class="section">Items</h2>
        ${(o.items || []).map((i) => `<div class="coline"><div><strong>${esc(i.productName)}</strong>${i.flavor ? ` <span class="muted">· ${esc(i.flavor)}</span>` : ""}<p class="muted small">${Number(i.amount)} × ${peso(i.unitPrice)}</p></div><strong>${peso(i.subtotal)}</strong></div>`).join("")}
        <div class="summary__row"><span>Subtotal</span><span>${peso(o.itemsSubtotal)}</span></div>
        <div class="summary__row"><span>${pickup ? "Pick-up" : "Delivery fee"}</span><span>${pickup ? "Free" : o.deliveryFeeUnresolved ? "To be confirmed" : peso(o.deliveryFee)}</span></div>
        <div class="summary__row summary__row--total"><span>Total</span><span>${peso(o.total)}</span></div>
      </div>
      ${o.rating ? `<div class="card"><h2 class="section">Your rating</h2><p class="stars">${"★".repeat(o.rating)}${"☆".repeat(5 - o.rating)}</p>${o.feedback ? `<p>${esc(o.feedback)}</p>` : ""}</div>` : ""}
      <div class="actions">
        ${o.status === "pending" ? `<button class="btn btn--danger" id="od-cancel">Cancel order</button>` : ""}
        ${o.status === "delivered" && !o.rating ? `<button class="btn btn--primary" id="od-rate">Rate this order</button>` : ""}
      </div>
    </section>`;
  $("#od-cancel")?.addEventListener("click", () => cancelOrder(o));
  $("#od-rate")?.addEventListener("click", () => rateOrder(o));
  if (o.status === "delivered" && !o.rating && !o.ratingPromptDismissed && !sessionStorage.getItem(`rated_${o.id}`)) {
    sessionStorage.setItem(`rated_${o.id}`, "1");
    rateOrder(o, true);
  }
}

function cancelOrder(o) {
  let reason = "";
  const { modal, close } = openModal(`
    <div class="modal__head"><h3>Cancel this order?</h3><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="modal__body">
      <p class="muted">Tell us why you're cancelling.</p>
      <div class="radios">${CANCEL_REASONS.map((r, i) => `<label><input type="radio" name="cr" value="${i}"> ${esc(r)}</label>`).join("")}</div>
      <textarea id="cr-other" rows="2" placeholder="Please specify" hidden maxlength="150"></textarea>
    </div>
    <div class="modal__foot"><button class="btn btn--outline" data-close>Keep order</button><button class="btn btn--danger" id="cr-go" disabled>Cancel order</button></div>`);
  const go = $("#cr-go", modal), other = $("#cr-other", modal);
  const sync = () => {
    const sel = modal.querySelector("input[name=cr]:checked");
    const isOther = sel && Number(sel.value) === CANCEL_REASONS.length - 1;
    other.hidden = !isOther;
    reason = !sel ? "" : isOther ? other.value.trim() : CANCEL_REASONS[Number(sel.value)];
    go.disabled = !reason;
  };
  modal.addEventListener("change", sync); other.addEventListener("input", sync);
  go.addEventListener("click", async () => {
    go.disabled = true; go.textContent = "Cancelling...";
    try {
      await updateDoc(doc(db, "orders", o.id), { status: "cancelled", cancelReason: reason });
      storeCall("app_restock", { ref: o.id }).catch((e) => console.error("Restock failed:", e));
      storeCall("app_notify_staff", { message: `Order #${o.id.slice(0, 6).toUpperCase()} was cancelled by ${o.customerName || "the customer"}`, orderId: o.id }).catch(() => {});
      const local = state.history.find((x) => x.id === o.id); if (local) { local.status = "cancelled"; local.cancelReason = reason; }
      toast("Order cancelled.", "success");
      close();
    } catch (e) { console.error("Cancel failed:", e); toast("Couldn't cancel the order. It may already be approved.", "error"); go.disabled = false; go.textContent = "Cancel order"; }
  });
}

function rateOrder(o, auto = false) {
  let stars = 0;
  const { modal, close } = openModal(`
    <div class="modal__head"><h3>How was your order?</h3><button class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="modal__body">
      <div class="starpick" role="radiogroup">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" aria-label="${n} star${n > 1 ? "s" : ""}">☆</button>`).join("")}</div>
      <textarea id="rt-text" rows="3" placeholder="Tell us more (optional)" maxlength="500"></textarea>
    </div>
    <div class="modal__foot"><button class="btn btn--outline" id="rt-later">Not now</button><button class="btn btn--primary" id="rt-go" disabled>Submit</button></div>`,
    { onClose: () => {} });
  modal.addEventListener("click", (e) => {
    const s = e.target.closest("[data-star]");
    if (s) { stars = Number(s.dataset.star); modal.querySelectorAll("[data-star]").forEach((b) => { b.textContent = Number(b.dataset.star) <= stars ? "★" : "☆"; }); $("#rt-go", modal).disabled = false; }
  });
  $("#rt-later", modal).addEventListener("click", async () => {
    if (auto) await updateDoc(doc(db, "orders", o.id), { ratingPromptDismissed: true }).catch(() => {});
    close();
  });
  $("#rt-go", modal).addEventListener("click", async () => {
    try {
      await updateDoc(doc(db, "orders", o.id), { rating: stars, feedback: $("#rt-text", modal).value.trim(), ratedAt: serverTimestamp() });
      const local = state.history.find((x) => x.id === o.id); if (local) { local.rating = stars; local.feedback = $("#rt-text", modal).value.trim(); }
      toast("Thanks for your feedback!", "success");
      close();
      if (route().name === "order") renderOrderDetails(o.id);
    } catch (e) { console.error("Rating failed:", e); toast("Couldn't save your rating. Try again.", "error"); }
  });
}

// ----------------------------- CHATBOT ("Ask Almares 328") -----------------------------
// Same worker the app uses. Chats live only in memory, like the app.
const CHAT_URL = "https://almares-328-chat-proxy.eldefonsojrletigio.workers.dev";
const CHAT_GREETING = "Hi! I'm the Almares 328 assistant. I can help with products, prices, wholesale, ordering and your order status. What would you like to know?";
const CHAT_POOL = [
  "How do I place an order?", "How does wholesale pricing work?", "Where are your branches?", "How do I cancel my order?",
  "What do the order statuses mean?", "What are the best sellers?", "How much is the delivery fee?", "Can I pick up my order in store?",
  "Is there a discount right now?", "Where is my order?"
];
const CONTACT_Q = "What's your contact number?";
let chat = { open: false, messages: [], quick: [], busy: false };
function newChat() {
  const picks = [...CHAT_POOL].sort(() => Math.random() - 0.5).slice(0, 2);
  chat.messages = [{ role: "assistant", content: CHAT_GREETING }];
  chat.quick = [...picks, CONTACT_Q];
  chat.busy = false;
}
newChat();

function mdToHtml(text) {
  const lines = esc(text).split("\n");
  let html = "", inList = false;
  for (const raw of lines) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    const m = line.match(/^\s*[-*]\s+(.*)$/);
    if (m) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${m[1]}</li>`; }
    else { if (inList) { html += "</ul>"; inList = false; } html += line.trim() ? `<p>${line}</p>` : ""; }
  }
  return html + (inList ? "</ul>" : "");
}

function chatRoot() {
  let el = document.getElementById("chat-root");
  if (!el) { el = document.createElement("div"); el.id = "chat-root"; document.body.appendChild(el); }
  return el;
}
function renderChat() {
  const root = chatRoot();
  if (!state.user) { root.innerHTML = ""; return; }
  const log = chat.messages.map((m) => `<div class="chat__msg chat__msg--${m.role === "user" ? "me" : "bot"}">${m.role === "user" ? `<p>${esc(m.content)}</p>` : mdToHtml(m.content)}</div>`).join("")
    + (chat.busy ? `<div class="chat__msg chat__msg--bot chat__typing"><span></span><span></span><span></span></div>` : "")
    + (chat.messages.length === 1 && !chat.busy ? `<div class="chat__quick">${chat.quick.map((q) => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>` : "");
  const keepScroll = root.querySelector(".chat__log");
  const wasBottom = !keepScroll || keepScroll.scrollHeight - keepScroll.scrollTop - keepScroll.clientHeight < 60;
  const draft = root.querySelector(".chat__input")?.value || "";
  root.innerHTML = `
    ${chat.open ? `
    <section class="chat" role="dialog" aria-label="Ask Almares 328">
      <header class="chat__head"><strong>Ask Almares 328</strong><span><button type="button" data-chat="new" title="New chat">↻</button><button type="button" data-chat="close" title="Close">✕</button></span></header>
      <div class="chat__log">${log}</div>
      <form class="chat__form"><input class="chat__input" placeholder="Type your question..." maxlength="500" autocomplete="off" ${chat.busy ? "disabled" : ""}><button class="btn btn--primary btn--sm" ${chat.busy ? "disabled" : ""}>Send</button></form>
    </section>` : ""}
    <button type="button" class="chat__fab" data-chat="toggle" aria-label="Ask Almares 328">${chat.open ? "✕" : "💬"}</button>`;
  const inp = root.querySelector(".chat__input");
  if (inp) { inp.value = draft; if (!chat.busy) inp.focus(); }
  const lg = root.querySelector(".chat__log");
  if (lg && wasBottom) lg.scrollTop = lg.scrollHeight;
}
document.addEventListener("click", (e) => {
  const root = document.getElementById("chat-root");
  if (!root || !root.contains(e.target)) return;
  const act = e.target.closest("[data-chat]")?.dataset.chat;
  if (act === "toggle") { chat.open = !chat.open; renderChat(); }
  else if (act === "close") { chat.open = false; renderChat(); }
  else if (act === "new") { newChat(); renderChat(); }
  const q = e.target.closest("[data-q]");
  if (q) sendChat(q.dataset.q);
});
document.addEventListener("submit", (e) => {
  if (!e.target.classList.contains("chat__form")) return;
  e.preventDefault();
  const input = e.target.querySelector(".chat__input");
  const text = input.value.trim();
  if (text) { input.value = ""; sendChat(text); }
});
async function sendChat(text) {
  if (chat.busy || !state.user) return;
  chat.messages.push({ role: "user", content: text });
  chat.busy = true;
  renderChat();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(CHAT_URL, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${await state.user.getIdToken()}` },
      body: JSON.stringify({ messages: chat.messages.map((m) => ({ role: m.role, content: m.content })) })
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok || !data.reply) throw new Error(data?.error || `http_${res.status}`);
    chat.messages.push({ role: "assistant", content: data.reply });
  } catch (error) {
    console.error("Chat failed:", error);
    chat.messages.push({ role: "assistant", content: "Sorry, I couldn't answer right now. Please try again in a moment." });
  } finally { clearTimeout(timer); chat.busy = false; renderChat(); }
}

render();
