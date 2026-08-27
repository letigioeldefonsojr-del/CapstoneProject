import { db } from "./firebase-config.js";
import {
  collection, getDocs, onSnapshot, query, where, doc, getDoc, setDoc, deleteDoc, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { isProductInAlertState, getWorstAlertDetail } from "./StockAlerts.js";
import { getClearedSet, loadReadStatus } from "./ReadStatus.js";

// ====================================================================
// CHUNK 0 — CONFIG
// This page's own data needs only. Sidebar/auth/identity/clock/logout
// all live in Sidebar.js now and are shared by every page.
// ====================================================================
const ORDERS_COLLECTION = "orders";
const ORDER_DATE_FIELD = "createdAt";

// ====================================================================
// CHUNK 1 — WAIT FOR THE SHARED SIDEBAR TO FINISH ITS OWN SETUP
// ----------------------------------------------------------------
// Sidebar.js handles the auth guard and fires this event once a
// signed-in user is confirmed and identity/clock are wired up. This
// page's own content only starts loading after that.
// ====================================================================
document.addEventListener("sidebar:ready", (event) => {
  const { role, user } = event.detail;
  applyRoleVisibility(role);
  loadStats();
  loadRecentNotifications(user.uid);
  loadBannerPanel();
  wireBannerForm();
});

// ====================================================================
// CHUNK 1B — ROLE-BASED QUICK ACTION
// ----------------------------------------------------------------
// Employees can't add products (that's Admin-only), so instead of
// hiding this slot and leaving a gap in the grid, it becomes a
// genuinely useful employee action: jump straight into Inventory
// pre-filtered to what actually needs restocking.
// ====================================================================
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

// ====================================================================
// CHUNK 2 — LIVE STATS (Total Products, Low Stock, Orders Today)
// ====================================================================
function loadStats() {
  loadProductStats();
  loadOrdersTodayStat();
}

function loadProductStats() {
  onSnapshot(
    collection(db, "products"),
    (snap) => {
      const products = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      document.getElementById("stat-products-value").textContent = products.length;

      const lowStockCount = products.filter((product) => isProductInAlertState(product)).length;

      // The banner is specifically titled "Critically Low Stock Items
      // Warning" — so it only counts items actually in the critical
      // tier (not merely "low", and not "out of stock" either, since
      // an item at zero isn't "critically low", it's already gone).
      const criticalCount = products.filter((product) => {
        const detail = getWorstAlertDetail(product);
        return detail?.status === "critical";
      }).length;

      document.getElementById("stat-lowstock-value").textContent = lowStockCount;
      updateLowStockBanner(criticalCount);
    },
    (error) => {
      console.error("Couldn't load product stats:", error);
      document.getElementById("stat-products-value").textContent = "—";
      document.getElementById("stat-lowstock-value").textContent = "—";
    }
  );
}

function updateLowStockBanner(count) {
  const banner = document.getElementById("low-stock-banner");
  const countLabel = document.getElementById("low-stock-count");
  countLabel.textContent = count;
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

// ====================================================================
// CHUNK 3 — RECENT NOTIFICATIONS FEED
// ====================================================================
function loadRecentNotifications(uid) {
  const list = document.getElementById("notif-list");

  loadReadStatus(uid)
    .then(() => {
      onSnapshot(
        collection(db, "employeeNotifications"),
        (snap) => {
          const clearedSet = getClearedSet(uid);
          const visible = snap.docs
            .map((d) => {
              const data = d.data();
              return {
                id: d.id,
                message: data.message || "New notification",
                createdAtMillis: data.createdAt?.toMillis?.() || null
              };
            })
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
        },
        (error) => {
          console.error("Couldn't load notifications:", error);
          list.innerHTML = `<li class="notif-list__empty">Couldn't load notifications right now.</li>`;
        }
      );
    })
    .catch((error) => {
      console.error("Couldn't load read status for notifications:", error);
      list.innerHTML = `<li class="notif-list__empty">Couldn't load notifications right now.</li>`;
    });
}

// ====================================================================
// CHUNK — STORE BANNER
// ----------------------------------------------------------------
// Writes to settings/storeBanner — schema confirmed directly from the
// mobile app's lib/core/banner_helpers.dart: {offer, description,
// imageUrl, scheduleStart, scheduleEnd, updatedAt}. The customer app
// reads this same document live via a Firestore stream, so a save
// here shows up on their home screen immediately, no separate sync
// step needed. Available to both Admin and Employee (matches the
// existing settings write rule).
// ====================================================================
const BANNER_CLOUDINARY_CLOUD_NAME = "h5291fss";
const BANNER_CLOUDINARY_UPLOAD_PRESET = "productsweb";
const BANNER_CLOUDINARY_FOLDER = "banners";

let currentBannerImageUrl = null;

async function loadBannerPanel() {
  try {
    const snap = await getDoc(doc(db, "settings", "storeBanner"));
    if (!snap.exists()) {
      document.getElementById("banner-preview").hidden = true;
      return;
    }

    const data = snap.data();
    document.getElementById("banner-offer").value = data.offer || "";
    document.getElementById("banner-description").value = data.description || "";
    currentBannerImageUrl = data.imageUrl || null;

    if (data.scheduleStart?.toDate) {
      document.getElementById("banner-schedule-start").value = toDatetimeLocalValue(data.scheduleStart.toDate());
    }
    if (data.scheduleEnd?.toDate) {
      document.getElementById("banner-schedule-end").value = toDatetimeLocalValue(data.scheduleEnd.toDate());
    }

    renderBannerPreview(data);
  } catch (error) {
    console.error("Couldn't load store banner:", error);
  }
}

function renderBannerPreview(data) {
  const preview = document.getElementById("banner-preview");
  const imageEl = document.getElementById("banner-preview-image");

  if (!data.offer && !data.description) {
    preview.hidden = true;
    return;
  }

  preview.hidden = false;
  document.getElementById("banner-preview-offer").textContent = data.offer || "";
  document.getElementById("banner-preview-description").textContent = data.description || "";

  if (data.imageUrl) {
    imageEl.src = data.imageUrl;
    imageEl.hidden = false;
  } else {
    imageEl.hidden = true;
  }

  const scheduleEl = document.getElementById("banner-preview-schedule");
  const startDate = data.scheduleStart?.toDate?.();
  const endDate = data.scheduleEnd?.toDate?.();
  if (startDate || endDate) {
    const startText = startDate ? startDate.toLocaleDateString() : "now";
    const endText = endDate ? endDate.toLocaleDateString() : "no end date";
    scheduleEl.textContent = `Active ${startText} → ${endText}`;
  } else {
    scheduleEl.textContent = "Active always (no schedule set)";
  }
}

function toDatetimeLocalValue(dateObj) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}T${pad(dateObj.getHours())}:${pad(dateObj.getMinutes())}`;
}

function wireBannerForm() {
  const form = document.getElementById("banner-form");
  const removeBtn = document.getElementById("banner-remove-btn");

  form.addEventListener("submit", handleBannerSave);
  removeBtn.addEventListener("click", handleBannerRemove);
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

    await setDoc(doc(db, "settings", "storeBanner"), {
      offer,
      description,
      imageUrl: imageUrl || null,
      scheduleStart: startValue ? Timestamp.fromDate(new Date(startValue)) : null,
      scheduleEnd: endValue ? Timestamp.fromDate(new Date(endValue)) : null,
      updatedAt: serverTimestamp()
    });

    currentBannerImageUrl = imageUrl;
    showBannerStatus("Banner saved — now live on the customer app.", "success");
    await loadBannerPanel();
  } catch (error) {
    console.error("Couldn't save banner:", error);
    showBannerStatus("Couldn't save the banner. Please try again.", "error");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save Banner";
  }
}

async function handleBannerRemove() {
  const confirmed = window.confirm("Remove the current banner? Customers will stop seeing it immediately.");
  if (!confirmed) return;

  try {
    await deleteDoc(doc(db, "settings", "storeBanner"));
    document.getElementById("banner-form").reset();
    currentBannerImageUrl = null;
    document.getElementById("banner-preview").hidden = true;
    showBannerStatus("Banner removed.", "success");
  } catch (error) {
    console.error("Couldn't remove banner:", error);
    showBannerStatus("Couldn't remove the banner. Please try again.", "error");
  }
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
