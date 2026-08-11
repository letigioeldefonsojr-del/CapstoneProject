import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getProducts } from "./ProductCache.js";
import { getNotifications } from "./NotificationCache.js";
import { getReadSet, getClearedSet, loadReadStatus } from "./ReadStatus.js";
import { promptDeleteAccount } from "./DeleteAccount.js";
import { confirmDialog } from "./ConfirmDialog.js";

// ====================================================================
// CHUNK 0 — CONFIG
// Shared across every page that includes this file. Adjust here once
// instead of in five separate places.
// ====================================================================
const LOGIN_PAGE_URL = "Index.html";

const EMPLOYEE_COLLECTION = "employees";
const EMPLOYEE_NAME_FIELD = "firstName";
const ADMIN_COLLECTION = "admins";

const STOCK_FIELD = "stockCount";
const PRODUCT_AVAILABLE_FIELD = "available";
const LOW_STOCK_THRESHOLD = 99;

// ====================================================================
// CHUNK 1 — ROUTE GUARD
// ----------------------------------------------------------------
// Runs on every page that includes Sidebar.js. Nobody without an
// active Firebase Auth session sees any of these pages.
// ====================================================================
onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = LOGIN_PAGE_URL;
    return;
  }
  initSidebar(user);
});

async function initSidebar(user) {
  const role = await resolveRole(user.uid);

  renderIdentity(role, user);
  startClock();
  highlightActiveNav();
  loadNotifBadge(user.uid);
  wireCollapse();
  wireLogout();
  wireDeleteAccount(user, role);

  // Let the page's own script (Dashboard.js, Inventory.js, etc.) know
  // the sidebar is ready and what role is logged in, in case it needs
  // to adjust its own content (e.g. hiding an admin-only button).
  document.dispatchEvent(new CustomEvent("sidebar:ready", { detail: { role, user } }));
}

// ====================================================================
// CHUNK 1B — RESOLVE ROLE (sessionStorage cache, Firestore as fallback)
// ----------------------------------------------------------------
// sessionStorage is only set by Index.js's login/signup handlers — and
// it clears when the tab/browser closes. Firebase Auth's own session
// survives much longer than that, so someone can still be genuinely
// signed in with sessionStorage empty (e.g. reopening the browser
// later). The old code defaulted to "employee" whenever the cache was
// missing, which silently mis-labeled admin accounts. This checks the
// real source of truth instead — the same admins/employees docs your
// Firestore rules themselves check — and caches the result so normal
// in-app navigation still hits the fast sessionStorage path afterward.
// ====================================================================
async function resolveRole(uid) {
  const cached = sessionStorage.getItem("almares_role");
  if (cached) return cached;

  try {
    const adminSnap = await getDoc(doc(db, ADMIN_COLLECTION, uid));
    if (adminSnap.exists()) {
      sessionStorage.setItem("almares_role", "admin");
      return "admin";
    }
  } catch (error) {
    console.error("Couldn't check admin status:", error);
  }

  try {
    const employeeSnap = await getDoc(doc(db, EMPLOYEE_COLLECTION, uid));
    if (employeeSnap.exists()) {
      sessionStorage.setItem("almares_role", "employee");
      return "employee";
    }
  } catch (error) {
    console.error("Couldn't check employee status:", error);
  }

  // Signed in, but no matching doc in either collection — shouldn't
  // normally happen for an account created through this app's own
  // signup flows. Defaulting to "employee" here as before, but this
  // is now a genuine edge case worth investigating if it ever fires.
  console.warn(`Signed-in user ${uid} has no matching admins or employees document.`);
  return "employee";
}

// ====================================================================
// CHUNK 2 — IDENTITY / GREETING
// ====================================================================
async function renderIdentity(role, user) {
  const roleBadge = document.getElementById("role-badge");
  const greeting = document.getElementById("greeting");
  const avatar = document.getElementById("sidebar-avatar");
  if (roleBadge) roleBadge.textContent = role;

  let displayName = user.displayName || "there";

  if (role === "employee") {
    const cacheKey = `almares_display_name_${user.uid}`;
    const cached = sessionStorage.getItem(cacheKey);

    if (cached) {
      displayName = cached;
    } else {
      try {
        const snap = await getDoc(doc(db, EMPLOYEE_COLLECTION, user.uid));
        if (snap.exists() && snap.data()[EMPLOYEE_NAME_FIELD]) {
          displayName = snap.data()[EMPLOYEE_NAME_FIELD];
          sessionStorage.setItem(cacheKey, displayName);
        }
      } catch (error) {
        console.error("Couldn't load employee profile:", error);
      }
    }
  }

  if (greeting) greeting.textContent = `${timeOfDayGreeting()}, ${displayName}`;
  if (avatar) avatar.textContent = getInitials(displayName);
}

function getInitials(name) {
  if (!name || name === "there") return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return parts[0].slice(0, 2).toUpperCase();
}

function timeOfDayGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good Morning";
  if (hour < 18) return "Good Afternoon";
  return "Good Evening";
}

// ====================================================================
// CHUNK 3 — LIVE DATE / TIME
// ====================================================================
function startClock() {
  const dateEl = document.getElementById("topbar-date");
  const timeEl = document.getElementById("topbar-time");
  if (!dateEl || !timeEl) return;

  function tick() {
    const now = new Date();
    dateEl.textContent = now.toLocaleDateString(undefined, {
      weekday: "long", year: "numeric", month: "long", day: "numeric"
    });
    timeEl.textContent = now.toLocaleTimeString(undefined, {
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
  }

  tick();
  setInterval(tick, 1000);
}

// ====================================================================
// CHUNK 4 — ACTIVE NAV HIGHLIGHTING
// ----------------------------------------------------------------
// Each nav link's href is the real filename it points to (e.g.
// "Inventory.html"). Whichever one matches the current page gets
// the active state — no manual "which page am I on" flags needed.
// ====================================================================
function highlightActiveNav() {
  const currentPage = (window.location.pathname.split("/").pop() || "Dashboard.html").replace(/\.html$/i, "");

  document.querySelectorAll(".nav-item[href]").forEach((link) => {
    const linkPage = link.getAttribute("href").replace(/\.html$/i, "");
    link.classList.toggle("is-active", linkPage.toLowerCase() === currentPage.toLowerCase());
  });
}

// ====================================================================
// CHUNK 5 — NOTIFICATIONS BADGE (unread count, shown on every page)
// ----------------------------------------------------------------
// Combines synthesized stock alerts (any product not fully "In
// Stock") and real order notifications from employeeNotifications —
// both roles can read both sources now. Each item gets a stable ID
// ("stock-<productId>" or the real doc ID); read/cleared state is
// tracked per-UID (see ReadStatus.js) so Admin and Employee never
// share badge state. Cleared items never count, read-but-not-cleared
// items don't count either — only unread AND not-cleared does.
// ====================================================================
async function loadNotifBadge(uid) {
  const badge = document.getElementById("notif-badge");
  if (!badge) return;

  try {
    await loadReadStatus(uid);
    const readSet = getReadSet(uid);
    const clearedSet = getClearedSet(uid);
    const isUnread = (id) => !readSet.has(id) && !clearedSet.has(id);

    const products = await getProducts();
    const unreadStockAlerts = products.filter((product) => {
      const stock = product[STOCK_FIELD];
      const outOfStock = product[PRODUCT_AVAILABLE_FIELD] === false || stock === 0;
      const isAlert = outOfStock || (typeof stock === "number" && stock <= LOW_STOCK_THRESHOLD);
      return isAlert && isUnread(`stock-${product.id}`);
    }).length;

    const notifications = await getNotifications();
    const unreadOrders = notifications.filter((n) => isUnread(n.id)).length;

    const total = unreadStockAlerts + unreadOrders;
    if (total > 0) {
      badge.textContent = total;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  } catch (error) {
    console.error("Couldn't load notification badge count:", error);
  }
}

// ====================================================================
// CHUNK 6 — SIDEBAR COLLAPSE
// ====================================================================
function wireCollapse() {
  const sidebar = document.getElementById("sidebar");
  const collapseBtn = document.getElementById("collapse-btn");
  if (!sidebar || !collapseBtn) return;

  const isMobile = () => window.matchMedia("(max-width: 720px)").matches;

  collapseBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (isMobile()) {
      sidebar.classList.toggle("is-account-menu-open");
    } else {
      sidebar.classList.toggle("is-collapsed");
    }
  });

  // Mobile only: tapping anywhere outside the sidebar closes the
  // account menu, so Logout/Delete Account are never sitting exposed
  // during normal scrolling/tapping — they only ever show up right
  // after a deliberate tap on the menu button.
  document.addEventListener("click", (event) => {
    if (!isMobile()) return;
    if (!sidebar.classList.contains("is-account-menu-open")) return;
    if (sidebar.contains(event.target)) return;
    sidebar.classList.remove("is-account-menu-open");
  });
}

// ====================================================================
// CHUNK 7 — LOGOUT
// ====================================================================
function wireLogout() {
  const logoutBtn = document.getElementById("logout-btn");
  if (!logoutBtn) return;

  logoutBtn.addEventListener("click", async () => {
    const confirmed = await confirmDialog(
      "You'll need to log back in to continue.",
      { title: "Log out?", confirmLabel: "Log Out" }
    );
    if (!confirmed) return;

    try {
      await signOut(auth);
    } finally {
      sessionStorage.removeItem("almares_role");
      sessionStorage.removeItem("almares_employee_doc_id");
      window.location.href = LOGIN_PAGE_URL;
    }
  });
}

// ====================================================================
// CHUNK 8 — DELETE ACCOUNT
// ----------------------------------------------------------------
// The actual password-reentry + deletion flow lives in
// DeleteAccount.js — this just wires the sidebar button to it.
// ====================================================================
function wireDeleteAccount(user, role) {
  const deleteBtn = document.getElementById("delete-account-btn");
  if (!deleteBtn) return;

  deleteBtn.addEventListener("click", () => {
    promptDeleteAccount(user, role);
  });
}
