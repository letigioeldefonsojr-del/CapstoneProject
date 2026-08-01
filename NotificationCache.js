import { db } from "./firebase-config.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ====================================================================
// SHARED NOTIFICATION CACHE
// ----------------------------------------------------------------
// Same idea as ProductCache.js — Sidebar.js (badge) and
// Notifications.js both need this collection, so cache it once
// instead of fetching it twice per page load.
//
// One gotcha this avoids: Firestore Timestamp objects don't survive
// a JSON.stringify/parse round-trip with their .toDate() method
// intact. So this normalizes createdAt to a plain millisecond number
// (createdAtMillis) right here — every consumer works with a number,
// never a Timestamp, so the cache round-trip is safe by construction.
// ====================================================================
const NOTIFICATIONS_COLLECTION = "employeeNotifications";
const MESSAGE_FIELD = "message";
const DATE_FIELD = "createdAt";
const CACHE_KEY = "almares_notifications_cache";
const CACHE_TTL_MS = 30000; // shorter than products — this should feel closer to live

export async function getNotifications() {
  const cached = readCache();
  if (cached) return cached;

  const snap = await getDocs(collection(db, NOTIFICATIONS_COLLECTION));
  const notifications = snap.docs.map((docSnap) => {
    const data = docSnap.data();
    const ts = data[DATE_FIELD];
    return {
      id: docSnap.id,
      message: data[MESSAGE_FIELD] || "New notification",
      createdAtMillis: ts && typeof ts.toMillis === "function" ? ts.toMillis() : null
    };
  });

  writeCache(notifications);
  return notifications;
}

export function invalidateNotificationsCache() {
  sessionStorage.removeItem(CACHE_KEY);
}

function readCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { timestamp, notifications } = JSON.parse(raw);
    if (Date.now() - timestamp > CACHE_TTL_MS) return null;
    return notifications;
  } catch (error) {
    return null;
  }
}

function writeCache(notifications) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ timestamp: Date.now(), notifications }));
  } catch (error) {
    console.error("Couldn't cache notifications:", error);
  }
}
