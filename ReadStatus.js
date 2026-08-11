import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ====================================================================
// PER-USER READ / CLEARED TRACKING
// ----------------------------------------------------------------
// Two separate concepts, both scoped to the signed-in user's UID:
//
//   READ    — cosmetic only. Removes the bold/dot. Item still shows.
//   CLEARED — the item is hidden from that user's view entirely.
//
// Firestore-backed (moved off localStorage) so this survives a
// domain change during techno-transfer — localStorage is tied to the
// exact website address it was saved from, so switching domains
// would've silently reset everyone's read/cleared state. Firestore
// data follows the Firebase project, not the domain.
//
// Stored per-uid, NOT in the shared employeeNotifications collection
// itself — every employee/admin reads the same notification docs, so
// "cleared" has to live somewhere private to each account, or
// clearing it would hide it for everyone, not just the person who
// clicked it.
//
// API SHAPE: getReadSet/isRead/getClearedSet/isCleared stay
// SYNCHRONOUS on purpose, backed by an in-memory cache — so the many
// existing call sites across Sidebar.js/Notifications.js/Dashboard.js
// didn't all need to become async. The one thing every caller must do
// is `await loadReadStatus(uid)` ONCE before using those getters
// (typically right where they already resolve the signed-in uid).
// mark* functions update the cache immediately and persist to
// Firestore in the background.
// ====================================================================
const COLLECTION = "notificationStatus";
const cache = new Map(); // uid -> { readIds: Set, clearedIds: Set }

export async function loadReadStatus(uid) {
  if (cache.has(uid)) return; // already loaded this session, don't re-fetch

  try {
    const snap = await getDoc(doc(db, COLLECTION, uid));
    const data = snap.exists() ? snap.data() : {};
    cache.set(uid, {
      readIds: new Set(data.readIds || []),
      clearedIds: new Set(data.clearedIds || [])
    });
  } catch (error) {
    console.error("Couldn't load notification read/cleared status:", error);
    cache.set(uid, { readIds: new Set(), clearedIds: new Set() });
  }
}

function getEntry(uid) {
  // Fail-safe: if a caller forgot to await loadReadStatus() first,
  // this returns an empty (not-yet-persisted) entry rather than
  // throwing — everything just behaves as "nothing read/cleared yet"
  // until the real data loads.
  if (!cache.has(uid)) {
    cache.set(uid, { readIds: new Set(), clearedIds: new Set() });
  }
  return cache.get(uid);
}

function persist(uid) {
  const entry = getEntry(uid);
  setDoc(doc(db, COLLECTION, uid), {
    readIds: [...entry.readIds],
    clearedIds: [...entry.clearedIds]
  }).catch((error) => {
    console.error("Couldn't save notification state:", error);
  });
}

// ---- Read ----------------------------------------------------------
export function getReadSet(uid) {
  return getEntry(uid).readIds;
}

export function isRead(uid, id) {
  return getEntry(uid).readIds.has(id);
}

export function markRead(uid, id) {
  getEntry(uid).readIds.add(id);
  persist(uid);
}

export function markAllRead(uid, ids) {
  const entry = getEntry(uid);
  ids.forEach((id) => entry.readIds.add(id));
  persist(uid);
}

// ---- Cleared ---------------------------------------------------------
export function getClearedSet(uid) {
  return getEntry(uid).clearedIds;
}

export function isCleared(uid, id) {
  return getEntry(uid).clearedIds.has(id);
}

export function markAllCleared(uid, ids) {
  const entry = getEntry(uid);
  ids.forEach((id) => entry.clearedIds.add(id));
  persist(uid);
}
