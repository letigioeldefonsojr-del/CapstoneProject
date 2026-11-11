// sidebar — Shared sidebar: navigation, role, account menu, badges.

import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { doc, getDoc, collection, query, where, orderBy, limit, onSnapshot, getCountFromServer, Timestamp, enableNetwork, disableNetwork } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getWorstAlertDetail } from "./StockAlerts.js";
import { SUPABASE_ENABLED } from "./SupabaseConfig.js";
import { stockSummary, listNotifications } from "./SupabaseStore.js?v=20261029c";
import { getPreferences } from "./NotificationPreferences.js";
import { getReadSet, getClearedSet, loadReadStatus } from "./ReadStatus.js";
import { promptDeleteAccount } from "./DeleteAccount.js?v=20261109b";
import { promptChangePassword } from "./ChangePassword.js?v=20261111a";
import { confirmDialog } from "./ConfirmDialog.js";

const LOGIN_PAGE_URL = "/";

let latestProducts = null;
let latestProductTotal = null;
let latestNotifications = null;

function injectCashierNav() {
  const nav = document.querySelector(".sidebar__nav");
  if (!nav || nav.querySelector('a[href="Cashier"]')) return;
  const ordersLink = nav.querySelector('a[href="Orders"]');
  const link = document.createElement("a");
  link.href = "Cashier";
  link.className = "nav-item";
  link.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="5" y="3.5" width="14" height="5" rx="1.2" stroke="currentColor" stroke-width="1.7"/>
      <path d="M4 12.5H20L19 20.5H5L4 12.5Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
      <path d="M9 15.5V17.5M12 15.5V17.5M15 15.5V17.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
    <span class="nav-item__label">Cashier</span>`;
  if (ordersLink) nav.insertBefore(link, ordersLink); else nav.appendChild(link);
}
injectCashierNav();

const EMPLOYEE_COLLECTION = "employees";
const EMPLOYEE_NAME_FIELD = "firstName";
const ADMIN_COLLECTION = "admins";

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = LOGIN_PAGE_URL;
    return;
  }
  initSidebar(user);
});

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

  const isDriver = role === "employee" ? await resolveDriverFlag(user.uid) : false;
  document.documentElement.classList.remove("driver-check");
  document.documentElement.classList.toggle("is-driver", isDriver);
  if (isDriver && !onOrdersPage()) {
    window.location.replace("Orders.html");
    return;
  }

  const PREFS_KEY = "almares_prefs";
  let preferences = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(PREFS_KEY) || "null");
    if (saved && saved.uid === user.uid && saved.prefs) preferences = saved.prefs;
  } catch (e) { /* no saved copy */ }
  const savePrefs = (prefs) => {
    try { sessionStorage.setItem(PREFS_KEY, JSON.stringify({ uid: user.uid, prefs })); } catch (e) { /* fine */ }
  };
  if (preferences) {
    getPreferences(user.uid, role).then(savePrefs).catch(() => {});
  } else {
    preferences = await getPreferences(user.uid, role);
    savePrefs(preferences);
  }

  renderIdentity(role, user);
  if (isDriver) {
    const badge = document.getElementById("role-badge");
    if (badge) badge.textContent = "rider";
  }
  startClock();
  if (isDriver) applyDriverNav();
  highlightActiveNav();
  if (!isDriver) loadNotifBadge(user.uid, preferences);
  loadOrdersBadge();
  wireCollapse();
  wireLogout();
  wireScrollToTop();
  wireChangePassword(user);
  wireDeleteAccount(user, role);
  applyRoleRestrictedNavItems(role);

  watchAccountLive(user.uid, role);
  document.dispatchEvent(new CustomEvent("sidebar:ready", { detail: { role, user, preferences, isDriver } }));
}

const DRIVER_CACHE_KEY = "almares_driver";

function onOrdersPage() {
  const page = (window.location.pathname.split("/").pop() || "").replace(/\.html$/i, "").toLowerCase();
  return page === "orders";
}

async function fetchDriverFlag(uid) {
  const snap = await getDoc(doc(db, EMPLOYEE_COLLECTION, uid));
  return snap.exists() && snap.data().isDriver === true;
}

async function resolveDriverFlag(uid) {
  const cached = sessionStorage.getItem(DRIVER_CACHE_KEY);
  if (cached && cached.startsWith(`${uid}:`)) {
    const cachedValue = cached === `${uid}:1`;
    fetchDriverFlag(uid).then((fresh) => {
      if (fresh !== cachedValue) {
        sessionStorage.setItem(DRIVER_CACHE_KEY, `${uid}:${fresh ? 1 : 0}`);
        window.location.reload();
      }
    }).catch(() => {});
    return cachedValue;
  }
  try {
    const flag = await fetchDriverFlag(uid);
    sessionStorage.setItem(DRIVER_CACHE_KEY, `${uid}:${flag ? 1 : 0}`);
    return flag;
  } catch (error) {
    console.error("Couldn't check driver status:", error);
    return false;
  }
}

// Only Orders (and Log out) stay in the sidebar for a driver.
function applyDriverNav() {
  document.querySelectorAll(".sidebar__nav a.nav-item").forEach((link) => {
    if (link.getAttribute("href") !== "Orders") link.hidden = true;
  });
}

function applyRoleRestrictedNavItems(role) {
  if (role !== "admin") return;
  const feedbackLink = document.getElementById("feedback-nav-link");
  if (feedbackLink) feedbackLink.hidden = false;
  const accountsLink = document.getElementById("accounts-nav-link");
  if (accountsLink) accountsLink.hidden = false;
  const salesLink = document.getElementById("sales-nav-link");
  if (salesLink) salesLink.hidden = false;
}

async function resolveRole(uid) {
  const cached = sessionStorage.getItem("almares_role");

  if (cached) {
    checkAccountStillValid(uid, cached);
    return cached;
  }

  const [adminSnap, employeeSnap] = await Promise.allSettled([
    getDoc(doc(db, ADMIN_COLLECTION, uid)),
    getDoc(doc(db, EMPLOYEE_COLLECTION, uid))
  ]);

  if (adminSnap.status === "fulfilled" && adminSnap.value.exists()) {
    if (isSuspended(adminSnap.value.data())) {
      await signOutSuspended(adminSnap.value.data(), "admin");
      return null;
    }
    sessionStorage.setItem("almares_role", "admin");
    return "admin";
  }

  if (employeeSnap.status === "fulfilled" && employeeSnap.value.exists()) {
    if (isSuspended(employeeSnap.value.data())) {
      await signOutSuspended(employeeSnap.value.data(), "employee");
      return null;
    }
    if (isPendingApproval(employeeSnap.value.data())) {
      await signOutPending();
      return null;
    }
    sessionStorage.setItem("almares_role", "employee");
    return "employee";
  }

  console.warn(`Signed-in user ${uid} has no matching admins or employees document — signing out.`);
  await signOut(auth);
  window.location.href = LOGIN_PAGE_URL;
  return null;
}

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
      await signOutSuspended(snap.data(), role);
      return false;
    }

    if (role === "employee" && isPendingApproval(snap.data())) {
      await signOutPending();
      return false;
    }

    return true;
  } catch (error) {
    console.error("Couldn't verify account status:", error);
    return true;
  }
}

function isPendingApproval(data) {
  return data?.approved === false;
}

async function signOutPending() {
  console.warn("Employee account is waiting for admin approval — signing out.");
  await signOut(auth);
  sessionStorage.clear();
  window.location.href = "EmployeeLogin.html?pending=1";
}

let accountWatchOn = false;
function watchAccountLive(uid, role) {
  if (accountWatchOn) return;
  accountWatchOn = true;
  const collectionName = role === "admin" ? ADMIN_COLLECTION : EMPLOYEE_COLLECTION;
  let handled = false;
  onSnapshot(
    doc(db, collectionName, uid),
    (snap) => {
      if (handled || window.__almaresDeletingAccount) return;
      const data = snap.exists() ? snap.data() : null;
      if (!snap.exists() && snap.metadata.fromCache) return; // not a real answer yet
      if (!data) {
        handled = true;
        signOut(auth).finally(() => { sessionStorage.clear(); window.location.href = LOGIN_PAGE_URL; });
      } else if (isSuspended(data)) {
        handled = true;
        signOutSuspended(data, role);
      } else if (role === "employee" && isPendingApproval(data)) {
        handled = true;
        signOutPending();
      }
    },
    (error) => console.error("Couldn't watch the account status:", error) // fail open, like the page-load check
  );
}

function isSuspended(data) {
  const millis = data?.suspendedUntil?.toMillis?.();
  return millis != null && millis > Date.now();
}

async function signOutSuspended(data, role) {
  const untilDate = data.suspendedUntil.toDate().toLocaleDateString();
  const reason = data.suspensionReason || "";
  console.warn(`User is suspended until ${untilDate} — signing out.`);
  await signOut(auth);
  sessionStorage.clear();
  const targetPage = role === "admin" ? "AdminLogin.html" : "EmployeeLogin.html";
  window.location.href = `${targetPage}?suspended=${encodeURIComponent(untilDate)}&reason=${encodeURIComponent(reason)}`;
}

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

function highlightActiveNav() {
  const currentPage = (window.location.pathname.split("/").pop() || "Dashboard.html").replace(/\.html$/i, "");

  document.querySelectorAll(".nav-item[href]").forEach((link) => {
    const linkPage = link.getAttribute("href").replace(/\.html$/i, "");
    link.classList.toggle("is-active", linkPage.toLowerCase() === currentPage.toLowerCase());
  });
}

function loadOrdersBadge() {
  const link = document.querySelector('.sidebar__nav a[href="Orders"]');
  if (!link) return;

  let badge = document.getElementById("orders-badge");
  if (!badge) {
    badge = document.createElement("span");
    badge.className = "nav-item__badge";
    badge.id = "orders-badge";
    badge.hidden = true;
    link.appendChild(badge);
  }

  // Everyone (staff and drivers) sees the same count: Pending orders only.
  badge.title = "Pending orders";

  const WINDOW_DAYS = 7;
  let useWindow = true; // falls back to "all pending" if the date filter needs an index that is missing
  let lastRun = 0;
  let running = false;

  async function refreshBadge(force = false) {
    if (running || document.hidden) return;
    if (!force && Date.now() - lastRun < 10000) return; // never more than once per 10 seconds
    running = true;
    lastRun = Date.now();
    try {
      const ordersRef = collection(db, "orders");
      let count;
      if (useWindow) {
        try {
          const since = Timestamp.fromMillis(Date.now() - WINDOW_DAYS * 86400000);
          count = (await getCountFromServer(query(ordersRef, where("status", "==", "pending"), where("createdAt", ">=", since)))).data().count;
        } catch (error) {
          console.warn("Pending badge: date filter unavailable, counting all pending orders instead.", error?.code || error);
          useWindow = false;
        }
      }
      if (count === undefined) {
        count = (await getCountFromServer(query(ordersRef, where("status", "==", "pending")))).data().count;
      }
      badge.textContent = count > 99 ? "99+" : String(count);
      badge.hidden = count === 0;
    } catch (error) {
      console.error("Couldn't load orders for badge:", error);
    } finally {
      running = false;
    }
  }

  refreshBadge(true);
  setInterval(refreshBadge, 120000);
  document.addEventListener("visibilitychange", () => refreshBadge());
  document.addEventListener("orders:changed", () => refreshBadge());
}

async function loadNotifBadge(uid, preferences) {
  const badge = document.getElementById("notif-badge");
  if (!badge) return;

  try {
    await loadReadStatus(uid);
  } catch (error) {
    console.error("Couldn't load read status for notification badge:", error);
    return;
  }

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

  function recomputeUnreadCounts() {
    const freshReadSet = getReadSet(uid);
    const freshClearedSet = getClearedSet(uid);
    const stillUnread = (id) => !freshReadSet.has(id) && !freshClearedSet.has(id);

    unreadStockAlerts = preferences.stockAlerts && latestProducts
      ? latestProducts.filter((product) => {
          const detail = getWorstAlertDetail(product);
          return detail && stillUnread(`stock-${product.id}-${detail.status}`);
        }).length
      : 0;

    unreadOrders = preferences.orderNotifications && latestNotifications
      ? latestNotifications.filter((n) => stillUnread(n.id)).length
      : 0;

    renderBadge();
  }

  document.addEventListener("readstatus:changed", recomputeUnreadCounts);

  const publishProducts = (products, total) => {
    latestProducts = products;
    if (typeof total === "number") latestProductTotal = total;
    recomputeUnreadCounts();
    document.dispatchEvent(new CustomEvent("products:live", { detail: { products, total: latestProductTotal } }));
  };

  if (SUPABASE_ENABLED) {
    let busy = false;
    const refreshLowStock = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const { total, products } = await stockSummary();
        publishProducts(products.filter((p) => getWorstAlertDetail(p) !== null), total);
      } catch (error) {
        console.error("Couldn't load products for notification badge:", error);
        if (error.code === "not_staff") clearInterval(lowStockTimer);
      } finally { busy = false; }
    };
    refreshLowStock();
    const lowStockTimer = setInterval(refreshLowStock, 120000);
    document.addEventListener("visibilitychange", refreshLowStock);
    document.addEventListener("products:changed", refreshLowStock);
  } else {
  onSnapshot(
    query(collection(db, "products"), where("stockCount", "<=", 99), limit(30)),
    (snap) => publishProducts(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (error) => console.error("Couldn't load products for notification badge:", error)
  );
  }

  const publishNotifications = (list) => {
    latestNotifications = list;
    recomputeUnreadCounts();
    document.dispatchEvent(new CustomEvent("notifications:live", { detail: { notifications: latestNotifications } }));
  };

  if (SUPABASE_ENABLED) {
    let notifBusy = false;
    const refreshNotifications = async () => {
      if (notifBusy || document.hidden) return;
      notifBusy = true;
      try {
        publishNotifications(await listNotifications(100));
      } catch (error) {
        console.error("Couldn't load notifications for badge:", error);
        if (error.code === "not_staff") clearInterval(notifTimer);
      } finally { notifBusy = false; }
    };
    refreshNotifications();
    const notifTimer = setInterval(refreshNotifications, 20000);
    document.addEventListener("visibilitychange", refreshNotifications);
  } else {
  onSnapshot(
    query(collection(db, "employeeNotifications"), orderBy("createdAt", "desc"), limit(100)),
    (snap) => publishNotifications(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (error) => console.error("Couldn't load notifications for badge:", error)
  );
  }
}

export function getLatestProductTotal() { return latestProductTotal; }
export function getLatestProducts() {
  return latestProducts;
}

export function getLatestNotifications() {
  return latestNotifications;
}

function wireScrollToTop() {
  const btn = document.getElementById("scroll-to-top-btn");
  if (!btn) return;

  window.addEventListener("scroll", () => {
    btn.hidden = window.scrollY < 300;
  });

  btn.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

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

  document.addEventListener("click", (event) => {
    if (!isMobile()) return;
    if (!sidebar.classList.contains("is-account-menu-open")) return;
    if (sidebar.contains(event.target)) return;
    sidebar.classList.remove("is-account-menu-open");
  });
}

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
      sessionStorage.removeItem(DRIVER_CACHE_KEY);
      sessionStorage.removeItem("almares_employee_doc_id");
      window.location.href = LOGIN_PAGE_URL;
    }
  });
}

function wireDeleteAccount(user, role) {
  const deleteBtn = document.getElementById("delete-account-btn");
  if (!deleteBtn) return;

  deleteBtn.addEventListener("click", () => {
    promptDeleteAccount(user, role);
  });
}

function wireChangePassword(user) {
  const deleteBtn = document.getElementById("delete-account-btn");
  if (!deleteBtn || document.getElementById("change-password-btn")) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "change-password-btn";
  btn.className = "delete-account-link";
  btn.textContent = "Change Password";
  btn.style.paddingBottom = "6px";
  btn.addEventListener("mouseenter", () => { btn.style.color = "inherit"; });
  btn.addEventListener("mouseleave", () => { btn.style.color = ""; });
  btn.addEventListener("click", () => promptChangePassword(user));
  deleteBtn.before(btn);
}
