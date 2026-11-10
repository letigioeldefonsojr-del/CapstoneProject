// dashboard — Dashboard page: totals, charts, preferences, rider location bar.

import { db } from "./firebase-config.js";
import {
  collection, getDocs, getCountFromServer, query, where, doc, getDoc, setDoc, deleteDoc, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { isProductInAlertState, getWorstAlertDetail } from "./StockAlerts.js";
import { getClearedSet, loadReadStatus } from "./ReadStatus.js";
import { setPreferences } from "./NotificationPreferences.js";
import { getLatestProducts, getLatestProductTotal, getLatestNotifications } from "./Sidebar.js?v=20261029d";
import { SUPABASE_ENABLED } from "./SupabaseConfig.js";
import { sendPromotionPush } from "./PromotionPush.js";
import { confirmDialog } from "./ConfirmDialog.js";

const ORDERS_COLLECTION = "orders";
const ORDER_DATE_FIELD = "createdAt";

document.addEventListener("sidebar:ready", (event) => {
  const { role, user, preferences } = event.detail;
  applyRoleVisibility(role);
  loadStats();
  loadRecentNotifications(user.uid);
  loadBannerPanel();
  wireBannerForm();
  wireNotificationSettings(user.uid, role, preferences);
});

function applyRoleVisibility(role) {
  const action = document.getElementById("qa-role-action");
  const icon = document.getElementById("qa-role-icon");
  const label = document.getElementById("qa-role-label");

  if (role === "employee") {
    action.href = "Inventory.html?filter=attention";
    label.textContent = "Check Low Stock";
    icon.innerHTML = `
      <path d="M12 4L21 19.5H3L12 4Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
      <path d="M12 10V14.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
      <circle cx="12" cy="17" r="0.9" fill="currentColor"/>
    `;
  }
  // Admin keeps the default markup already in Dashboard.html (Add Product).
}

function loadStats() {
  loadProductStats();
  loadOrdersTodayStat();
}

function loadProductStats() {
  if (SUPABASE_ENABLED) {
    // Total comes with the sidebar's Supabase refresh (no Firebase reads).
    const showTotal = (n) => {
      if (typeof n === "number") document.getElementById("stat-products-value").textContent = n;
    };
    showTotal(getLatestProductTotal());
    document.addEventListener("products:live", (event) => showTotal(event.detail.total));
  } else {
  getCountFromServer(collection(db, "products"))
    .then((snap) => {
      document.getElementById("stat-products-value").textContent = snap.data().count;
    })
    .catch((error) => {
      console.error("Couldn't load total product count:", error);
      document.getElementById("stat-products-value").textContent = "—";
    });
  }

  function renderFromProducts(products) {
    const lowStockCount = products.filter((product) => isProductInAlertState(product)).length;

    const criticalCount = products.filter((product) => {
      const detail = getWorstAlertDetail(product);
      return detail?.status === "critical";
    }).length;

    document.getElementById("stat-lowstock-value").textContent = lowStockCount;
    updateLowStockBanner(criticalCount);
  }

  const alreadyLoaded = getLatestProducts();
  if (alreadyLoaded) renderFromProducts(alreadyLoaded);

  document.addEventListener("products:live", (event) => renderFromProducts(event.detail.products));
}

function wireNotificationSettings(uid, role, preferences) {
  const stockToggle = document.getElementById("pref-stock-alerts");
  const orderToggle = document.getElementById("pref-order-notifications");
  if (!stockToggle || !orderToggle) return;

  stockToggle.checked = preferences.stockAlerts;
  orderToggle.checked = preferences.orderNotifications;

  async function saveChange() {
    try {
      await setPreferences(uid, role, {
        stockAlerts: stockToggle.checked,
        orderNotifications: orderToggle.checked
      });
      try { sessionStorage.removeItem("almares_prefs"); } catch (e) { /* fine */ } // other pages re-read the saved settings
    } catch (error) {
      console.error("Couldn't save notification settings:", error);
    }
  }

  stockToggle.addEventListener("change", saveChange);
  orderToggle.addEventListener("change", saveChange);
}

function updateLowStockBanner(count) {
  const banner = document.getElementById("low-stock-banner");
  const message = document.getElementById("low-stock-message");
  message.textContent = `${count} item${count === 1 ? "" : "s"} ${count === 1 ? "needs" : "need"} restocking. Please review and order supplies.`;
  banner.hidden = count === 0;
}

async function loadOrdersTodayStat() {
  try {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfTomorrow = new Date(startOfToday);
    startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);

    const ordersRef = collection(db, ORDERS_COLLECTION);
    const todaysOrders = query(
      ordersRef,
      where(ORDER_DATE_FIELD, ">=", startOfToday),
      where(ORDER_DATE_FIELD, "<", startOfTomorrow)
    );
    const snap = await getDocs(todaysOrders);

    document.getElementById("stat-orders-value").textContent = snap.size;
  } catch (error) {
    console.error("Couldn't load today's orders:", error);
    document.getElementById("stat-orders-value").textContent = "—";
  }
}

function loadRecentNotifications(uid) {
  const list = document.getElementById("notif-list");

  function renderFromNotifications(notifications) {
    const clearedSet = getClearedSet(uid);
    const visible = notifications
      .map((data) => ({
        id: data.id,
        message: data.message || "New notification",
        createdAtMillis: data.createdAt?.toMillis?.() || null
      }))
      .filter((n) => !clearedSet.has(n.id));

    if (visible.length === 0) {
      list.innerHTML = `<li class="notif-list__empty">No recent notifications.</li>`;
      return;
    }

    const recent = [...visible]
      .sort((a, b) => (b.createdAtMillis || 0) - (a.createdAtMillis || 0))
      .slice(0, 5);

    list.innerHTML = "";
    recent.forEach((n) => {
      const timeLabel = n.createdAtMillis
        ? new Date(n.createdAtMillis).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
        : "";

      const item = document.createElement("li");
      item.className = "notif-list__item";
      item.innerHTML = `
        <span class="notif-list__message"></span>
        <span class="notif-list__time"></span>
      `;
      item.querySelector(".notif-list__message").textContent = n.message;
      item.querySelector(".notif-list__time").textContent = timeLabel;
      list.appendChild(item);
    });
  }

  loadReadStatus(uid)
    .then(() => {
      const alreadyLoaded = getLatestNotifications();
      if (alreadyLoaded) renderFromNotifications(alreadyLoaded);

      document.addEventListener("notifications:live", (event) => renderFromNotifications(event.detail.notifications));
    })
    .catch((error) => {
      console.error("Couldn't load read status for notifications:", error);
      list.innerHTML = `<li class="notif-list__empty">Couldn't load notifications right now.</li>`;
    });
}

const BANNER_CLOUDINARY_CLOUD_NAME = "h5291fss";
const BANNER_CLOUDINARY_UPLOAD_PRESET = "productsweb";
const BANNER_CLOUDINARY_FOLDER = "banners";
const BANNERS_COLLECTION = "storeBanners";
const MAX_BANNERS = 10;
const BANNER_EXPIRY_GRACE_HOURS = 12; // ended promotions are deleted this long after they end

let banners = [];            // [{id, ...data}] sorted by sortOrder
let editingBannerId = null;  // null = adding a new promotion
let currentBannerImageUrl = null;

async function loadBannerPanel() {
  try {
    const snap = await getDocs(collection(db, BANNERS_COLLECTION));
    banners = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    if (banners.length === 0) {
      // One-time import of the old single banner, if there is one.
      const legacy = await getDoc(doc(db, "settings", "storeBanner"));
      if (legacy.exists()) {
        const data = legacy.data();
        await setDoc(doc(db, BANNERS_COLLECTION, "legacy"), {
          offer: data.offer || "",
          description: data.description || "",
          imageUrl: data.imageUrl || null,
          scheduleStart: data.scheduleStart || null,
          scheduleEnd: data.scheduleEnd || null,
          sortOrder: 1,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
        banners = [{ id: "legacy", ...data, sortOrder: 1 }];
      }
    }

    const cutoff = Date.now() - BANNER_EXPIRY_GRACE_HOURS * 60 * 60 * 1000;
    const expired = banners.filter((b) => {
      const end = b.scheduleEnd?.toDate?.()?.getTime();
      return end && end < cutoff;
    });
    if (expired.length > 0) {
      const removed = [];
      for (const b of expired) {
        try {
          await deleteDoc(doc(db, BANNERS_COLLECTION, b.id));
          removed.push(b.id);
        } catch (error) {
          console.error("Couldn't remove an expired promotion:", error);
        }
      }
      banners = banners.filter((b) => !removed.includes(b.id));
      if (removed.length > 0) {
        banners.sort((x, y) => (x.sortOrder || 0) - (y.sortOrder || 0));
        await syncLegacyBanner();
      }
    }

    banners.sort((x, y) => (x.sortOrder || 0) - (y.sortOrder || 0));
    renderBannerList();
  } catch (error) {
    console.error("Couldn't load store banners:", error);
    document.getElementById("banner-list").innerHTML =
      `<p class="banner-list__empty">Couldn't load the promotions right now.</p>`;
  }
}

function bannerState(b) {
  const now = Date.now();
  const start = b.scheduleStart?.toDate?.()?.getTime();
  const end = b.scheduleEnd?.toDate?.()?.getTime();
  if (start && start > now) return { key: "scheduled", label: "Scheduled" };
  if (end && end < now) return { key: "ended", label: "Ended" };
  return { key: "live", label: "Live" };
}

function bannerScheduleText(b) {
  const start = b.scheduleStart?.toDate?.();
  const end = b.scheduleEnd?.toDate?.();
  if (!start && !end) return "Always on (no schedule)";
  return `${start ? start.toLocaleDateString() : "now"} → ${end ? end.toLocaleDateString() : "no end date"}`;
}

function renderBannerList() {
  const list = document.getElementById("banner-list");
  list.replaceChildren();

  if (banners.length === 0) {
    const empty = document.createElement("p");
    empty.className = "banner-list__empty";
    empty.textContent = "No promotions yet. Add one below.";
    list.appendChild(empty);
  }

  banners.forEach((b) => {
    const state = bannerState(b);
    const card = document.createElement("div");
    card.className = "banner-item";

    if (b.imageUrl) {
      const img = document.createElement("img");
      img.className = "banner-item__image";
      img.src = b.imageUrl;
      img.alt = "";
      card.appendChild(img);
    }

    const text = document.createElement("div");
    text.className = "banner-item__text";
    const title = document.createElement("strong");
    title.textContent = b.offer || "(no headline)";
    const desc = document.createElement("span");
    desc.textContent = b.description || "";
    const sched = document.createElement("span");
    sched.className = "banner-item__schedule";
    sched.textContent = bannerScheduleText(b);
    text.append(title, desc, sched);
    card.appendChild(text);

    const badge = document.createElement("span");
    badge.className = `banner-item__badge banner-item__badge--${state.key}`;
    badge.textContent = state.label;
    card.appendChild(badge);

    const actions = document.createElement("div");
    actions.className = "banner-item__actions";
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn-outline";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openBannerForm(b));
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn-danger-outline";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => handleBannerRemove(b));
    actions.append(editBtn, delBtn);
    card.appendChild(actions);

    list.appendChild(card);
  });

  const addBtn = document.getElementById("banner-add-btn");
  addBtn.disabled = banners.length >= MAX_BANNERS;
  addBtn.textContent = banners.length >= MAX_BANNERS
    ? `Limit reached (${MAX_BANNERS} promotions)`
    : (banners.length === 0 ? "+ Add a promotion" : "+ Add another promotion");
}

function openBannerForm(banner) {
  const form = document.getElementById("banner-form");
  form.reset();
  editingBannerId = banner ? banner.id : null;
  currentBannerImageUrl = banner?.imageUrl || null;

  document.getElementById("banner-form-title").textContent = banner ? "Edit promotion" : "New promotion";
  document.getElementById("banner-offer").value = banner?.offer || "";
  document.getElementById("banner-description").value = banner?.description || "";
  if (banner?.scheduleStart?.toDate) {
    document.getElementById("banner-schedule-start").value = toDatetimeLocalValue(banner.scheduleStart.toDate());
  }
  if (banner?.scheduleEnd?.toDate) {
    document.getElementById("banner-schedule-end").value = toDatetimeLocalValue(banner.scheduleEnd.toDate());
  }
  document.getElementById("banner-image-note").hidden = !currentBannerImageUrl;
  document.getElementById("banner-status").hidden = true;
  // Editing an existing promotion: don't re-send a push by default.
  document.getElementById("banner-notify").checked = !banner;

  const wrap = document.getElementById("banner-form-wrap");
  wrap.hidden = false;
  document.getElementById("banner-offer").focus({ preventScroll: true });
  wrap.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function closeBannerForm() {
  document.getElementById("banner-form-wrap").hidden = true;
  document.getElementById("banner-form").reset();
  editingBannerId = null;
  currentBannerImageUrl = null;
}

async function syncLegacyBanner() {
  const first = banners[0];
  try {
    if (!first) {
      await deleteDoc(doc(db, "settings", "storeBanner"));
      return;
    }
    await setDoc(doc(db, "settings", "storeBanner"), {
      offer: first.offer || "",
      description: first.description || "",
      imageUrl: first.imageUrl || null,
      scheduleStart: first.scheduleStart || null,
      scheduleEnd: first.scheduleEnd || null,
      updatedAt: serverTimestamp()
    });
  } catch (error) {
    console.error("Couldn't update the legacy banner document:", error);
  }
}

function wireBannerForm() {
  document.getElementById("banner-form").addEventListener("submit", handleBannerSave);
  document.getElementById("banner-add-btn").addEventListener("click", () => openBannerForm(null));
  document.getElementById("banner-cancel-btn").addEventListener("click", closeBannerForm);
}

function showBannerStatus(message, kind) {
  const el = document.getElementById("banner-status");
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
}

async function handleBannerSave(event) {
  event.preventDefault();
  const saveBtn = document.getElementById("banner-save-btn");
  const offer = document.getElementById("banner-offer").value.trim();
  const description = document.getElementById("banner-description").value.trim();
  const imageFile = document.getElementById("banner-image").files[0];
  const startValue = document.getElementById("banner-schedule-start").value;
  const endValue = document.getElementById("banner-schedule-end").value;

  if (!offer && !description) {
    showBannerStatus("Add at least an offer or a description.", "error");
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";

  try {
    let imageUrl = currentBannerImageUrl;
    if (imageFile) {
      imageUrl = await uploadBannerImage(imageFile);
    }

    const existing = banners.find((b) => b.id === editingBannerId);
    const payload = {
      offer,
      description,
      imageUrl: imageUrl || null,
      scheduleStart: startValue ? Timestamp.fromDate(new Date(startValue)) : null,
      scheduleEnd: endValue ? Timestamp.fromDate(new Date(endValue)) : null,
      updatedAt: serverTimestamp()
    };

    if (existing) {
      await setDoc(doc(db, BANNERS_COLLECTION, existing.id), {
        ...payload,
        sortOrder: existing.sortOrder || Date.now(),
        createdAt: existing.createdAt || serverTimestamp()
      });
    } else {
      await setDoc(doc(collection(db, BANNERS_COLLECTION)), {
        ...payload,
        sortOrder: Date.now(),
        createdAt: serverTimestamp()
      });
    }

    let statusText = "Promotion saved — now in the customer app's banner.";

    if (document.getElementById("banner-notify")?.checked) {
      const now = Date.now();
      const startsLater = startValue && new Date(startValue).getTime() > now;
      const alreadyEnded = endValue && new Date(endValue).getTime() < now;
      if (startsLater) {
        statusText += " Starts later, so no push was sent.";
      } else if (!alreadyEnded) {
        const text = [offer, description].filter(Boolean).join(" — ");
        const pushResult = await sendPromotionPush(text);
        statusText += pushResult.ok
          ? " Customers with promotions on were notified."
          : " The push notification couldn't be sent.";
      }
    }

    await loadBannerPanel();
    await syncLegacyBanner();
    showBannerStatus(statusText, "success");
    setTimeout(closeBannerForm, 1800);
  } catch (error) {
    console.error("Couldn't save banner:", error);
    showBannerStatus("Couldn't save the promotion. Please try again.", "error");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save Promotion";
  }
}

async function handleBannerRemove(banner) {
  const label = banner.offer || banner.description || "untitled";
  const confirmed = await confirmDialog(
    `Delete the promotion "${label}"? Customers will stop seeing it immediately.`,
    { title: "Delete promotion?", confirmLabel: "Delete", cancelLabel: "Cancel", danger: true }
  );
  if (!confirmed) return;

  try {
    await deleteDoc(doc(db, BANNERS_COLLECTION, banner.id));
    if (editingBannerId === banner.id) closeBannerForm();

    banners = banners.filter((b) => b.id !== banner.id);
    banners.sort((x, y) => (x.sortOrder || 0) - (y.sortOrder || 0));
    await syncLegacyBanner(); // removes (or updates) the old copy so it can't come back
    renderBannerList();
  } catch (error) {
    console.error("Couldn't remove banner:", error);
    await confirmDialog("Couldn't delete the promotion. Please try again.", {
      title: "Delete failed", confirmLabel: "OK", cancelLabel: "Close"
    });
  }
}

function toDatetimeLocalValue(dateObj) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}T${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`;
}

async function uploadBannerImage(file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", BANNER_CLOUDINARY_UPLOAD_PRESET);
  formData.append("folder", BANNER_CLOUDINARY_FOLDER);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${BANNER_CLOUDINARY_CLOUD_NAME}/image/upload`,
    { method: "POST", body: formData }
  );

  if (!response.ok) {
    throw new Error(`Cloudinary upload failed with status ${response.status}`);
  }

  const data = await response.json();
  return data.secure_url;
}
