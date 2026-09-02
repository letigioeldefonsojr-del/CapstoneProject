import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { doc, getDoc, collection, query, where, onSnapshot, enableNetwork, disableNetwork } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getWorstAlertDetail } from "./StockAlerts.js";
import { getReadSet, getClearedSet, loadReadStatus } from "./ReadStatus.js";
import { promptDeleteAccount } from "./DeleteAccount.js";
import { confirmDialog } from "./ConfirmDialog.js";

// ====================================================================
// CHUNK 0 — CONFIG
// Shared across every page that includes this file. Adjust here once
// instead of in five separate places.
// ====================================================================
const LOGIN_PAGE_URL = "Index.html";

// Latest live data from Sidebar.js's own listeners, shared with other
// pages via getLatestProducts()/getLatestNotifications() below and the
// "products:live"/"notifications:live" events, so they don't need to
// open their own duplicate Firestore listeners on the same data.
let latestProducts = null;
let latestNotifications = null;

const EMPLOYEE_COLLECTION = "employees";
const EMPLOYEE_NAME_FIELD = "firstName";
const ADMIN_COLLECTION = "admins";

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

// ====================================================================
// STALE CONNECTION RECOVERY
// ----------------------------------------------------------------
// Firestore's real-time listeners (onSnapshot) rely on a persistent
// connection — after a PC sleeps, or a browser tab sits backgrounded
// for a while, that connection can go stale without automatically
// recovering on its own. Every live listener across the app (this
// badge, plus whatever each individual page has open — Orders,
// Accounts, Feedback, etc.) can end up silently frozen, showing old
// data with no indication anything's wrong, until a manual reload.
//
// This runs on every page (Sidebar.js is loaded everywhere) and
// watches for the tab becoming visible again after being hidden for
// a while — the exact moment this problem would show up. When that
// happens, it forces Firestore to fully tear down and re-establish
// its connection (disableNetwork then enableNetwork — Firestore's own
// documented way to recover from this), which automatically resumes
// every active listener on the page cleanly, without needing an
// actual page reload.
// ====================================================================
const STALE_THRESHOLD_MS = 60 * 1000; // only bother reconnecting if hidden for at least a minute — no need for brief tab-switches
let hiddenSinceMillis = null;

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenSinceMillis = Date.now();
    return;
  }

  // Became visible again
  if (hiddenSinceMillis && Date.now() - hiddenSinceMillis >= STALE_THRESHOLD_MS) {
    recoverStaleConnection();
  }
  hiddenSinceMillis = null;
});

async function recoverStaleConnection() {
  try {
    await disableNetwork(db);
    await enableNetwork(db);
  } catch (error) {
    console.error("Couldn't recover Firestore connection after being idle:", error);
  }
}

async function initSidebar(user) {
  const role = await resolveRole(user.uid);
  if (!role) return; // resolveRole already signed out and is redirecting — nothing more to do here

  renderIdentity(role, user);
  startClock();
  highlightActiveNav();
  loadNotifBadge(user.uid);
  wireCollapse();
  wireLogout();
  wireDeleteAccount(user, role);
  applyRoleRestrictedNavItems(role);

  // Let the page's own script (Dashboard.js, Inventory.js, etc.) know
  // the sidebar is ready and what role is logged in, in case it needs
  // to adjust its own content (e.g. hiding an admin-only button).
  document.dispatchEvent(new CustomEvent("sidebar:ready", { detail: { role, user } }));
}

// Feedback and Accounts are admin-only — hidden by default directly
// in the HTML (not just hidden via JS after the fact) so there's no
// flash of them being visible before role resolution finishes. This
// just reveals them once confirmed admin.
function applyRoleRestrictedNavItems(role) {
  if (role !== "admin") return;
  const feedbackLink = document.getElementById("feedback-nav-link");
  if (feedbackLink) feedbackLink.hidden = false;
  const accountsLink = document.getElementById("accounts-nav-link");
  if (accountsLink) accountsLink.hidden = false;
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

  if (cached) {
    // Don't make every page load wait on a network round-trip just to
    // recheck something that's true the overwhelming majority of the
    // time (not suspended). Return the cached role immediately so the
    // UI (nav links, identity, etc.) appears instantly — and check
    // suspension/termination in the BACKGROUND at the same time. If
    // that background check finds a real problem, it signs out and
    // redirects at that point, same as before — this only changes
    // when the check happens relative to the UI, not whether it
    // happens.
    checkAccountStillValid(uid, cached);
    return cached;
  }

  const [adminSnap, employeeSnap] = await Promise.allSettled([
    getDoc(doc(db, ADMIN_COLLECTION, uid)),
    getDoc(doc(db, EMPLOYEE_COLLECTION, uid))
  ]);

  if (adminSnap.status === "fulfilled" && adminSnap.value.exists()) {
    if (isSuspended(adminSnap.value.data())) {
      await signOutSuspended(adminSnap.value.data());
      return null;
    }
    sessionStorage.setItem("almares_role", "admin");
    return "admin";
  }

  if (employeeSnap.status === "fulfilled" && employeeSnap.value.exists()) {
    if (isSuspended(employeeSnap.value.data())) {
      await signOutSuspended(employeeSnap.value.data());
      return null;
    }
    sessionStorage.setItem("almares_role", "employee");
    return "employee";
  }

  // Signed in via Firebase Auth, but no matching Firestore document —
  // this is exactly the state of someone who authenticated via
  // Google/started signup but never actually finished (e.g. abandoned
  // the "Complete Your Profile" step, or pressed back mid-flow).
  // Previously this defaulted to "employee" and let them straight
  // into the app — a real gap, since it completely bypassed the
  // Staff Code check. Sign them out and send them back instead.
  console.warn(`Signed-in user ${uid} has no matching admins or employees document — signing out.`);
  await signOut(auth);
  window.location.href = LOGIN_PAGE_URL;
  return null;
}

// Re-checked on every page load once role is already cached — catches
// both suspension and termination happening mid-session, not just at
// the next fresh login.
async function checkAccountStillValid(uid, role) {
  const collectionName = role === "admin" ? ADMIN_COLLECTION : EMPLOYEE_COLLECTION;

  try {
    const snap = await getDoc(doc(db, collectionName, uid));

    if (!snap.exists()) {
      console.warn(`User ${uid} (${role}) no longer has a matching document — signing out.`);
      await signOut(auth);
      sessionStorage.clear();
      window.location.href = LOGIN_PAGE_URL;
      return false;
    }

    if (isSuspended(snap.data())) {
      await signOutSuspended(snap.data());
      return false;
    }

    return true;
  } catch (error) {
    // Fail open — a network blip checking this shouldn't lock out a
    // legitimate, currently-valid session.
    console.error("Couldn't verify account status:", error);
    return true;
  }
}

function isSuspended(data) {
  const millis = data?.suspendedUntil?.toMillis?.();
  return millis != null && millis > Date.now();
}

async function signOutSuspended(data) {
  const untilDate = data.suspendedUntil.toDate().toLocaleDateString();
  const reason = data.suspensionReason || "";
  console.warn(`User is suspended until ${untilDate} — signing out.`);
  await signOut(auth);
  sessionStorage.clear();
  window.location.href = `${LOGIN_PAGE_URL}?suspended=${encodeURIComponent(untilDate)}&reason=${encodeURIComponent(reason)}`;
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
  } catch (error) {
    console.error("Couldn't load read status for notification badge:", error);
    return;
  }

  const readSet = getReadSet(uid);
  const clearedSet = getClearedSet(uid);
  const isUnread = (id) => !readSet.has(id) && !clearedSet.has(id);

  let unreadStockAlerts = 0;
  let unreadOrders = 0;

  function renderBadge() {
    const total = unreadStockAlerts + unreadOrders;
    if (total > 0) {
      badge.textContent = total;
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  // Real-time: recomputes the moment ANY product's stock changes, not
  // just on page load / after a cache expires. Uses the shared,
  // variant-aware check — a variant-only product's stock going to 0
  // now correctly triggers this, which the old per-page duplicated
  // logic (checking only the flat parent stock field) silently missed.
  //
  // SCALABILITY FIX: previously fetched the ENTIRE products
  // collection just to check stock levels — on a catalog of
  // thousands of products, that's thousands of documents downloaded
  // and processed on every single page load, everywhere, just for a
  // badge count. This query only pulls products whose stockCount is
  // already ≤99 (the low-stock threshold) — an indexed range query,
  // not a full scan — so the amount of data fetched stays small and
  // proportional to how many products actually need attention, not
  // how large the whole catalog is.
  //
  // HONEST LIMITATION: this specific query can't see INTO a variant
  // product's nested flavors array (Firestore can't efficiently query
  // that), so a variant-only product (parent stockCount left null,
  // stock tracked per-variant instead) won't be caught by this query
  // even if a specific variant is critically low. A fully complete
  // fix would need a computed status field written at product-update
  // time in Inventory.js (every Add/Edit/CSV-import/Scan/Stock-Count
  // path) — a real, doable follow-up, just larger in scope than this
  // pass. For a catalog that's mostly non-variant products, this
  // still closes the overwhelming majority of the actual scale
  // problem today.
  //
  // Also dispatches this same data as a shared event ("products:live")
  // so other pages (Dashboard.js, etc.) can reuse it instead of
  // opening their OWN separate live listener on the same collection —
  // Sidebar.js runs on every page already, so this was genuinely
  // duplicated work slowing down every single page load.
  onSnapshot(
    query(collection(db, "products"), where("stockCount", "<=", 99)),
    (snap) => {
      const products = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      latestProducts = products;
      unreadStockAlerts = products.filter((product) => {
        const detail = getWorstAlertDetail(product);
        return detail && isUnread(`stock-${product.id}-${detail.status}`);
      }).length;
      renderBadge();
      document.dispatchEvent(new CustomEvent("products:live", { detail: { products } }));
    },
    (error) => console.error("Couldn't load products for notification badge:", error)
  );

  // Same idea — shared with Dashboard.js/Notifications.js via
  // "notifications:live" instead of each maintaining its own
  // duplicate listener on this same collection.
  onSnapshot(
    collection(db, "employeeNotifications"),
    (snap) => {
      latestNotifications = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      unreadOrders = snap.docs.filter((d) => isUnread(d.id)).length;
      renderBadge();
      document.dispatchEvent(new CustomEvent("notifications:live", { detail: { notifications: latestNotifications } }));
    },
    (error) => console.error("Couldn't load notifications for badge:", error)
  );
}

// Exposed so a page whose own script runs AFTER Sidebar.js's first
// snapshot already arrived can grab the current data immediately,
// instead of only being able to react to the NEXT change (closes a
// small timing gap the events alone wouldn't cover).
export function getLatestProducts() {
  return latestProducts;
}

export function getLatestNotifications() {
  return latestNotifications;
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
