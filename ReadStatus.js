// read-status — Per-user read and cleared tracking for notifications.

import { db } from "./firebase-config.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

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
  if (!cache.has(uid)) {
    cache.set(uid, { readIds: new Set(), clearedIds: new Set() });
  }
  return cache.get(uid);
}

function persist(uid) {
  const entry = getEntry(uid);
  return setDoc(doc(db, COLLECTION, uid), {
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
  return persist(uid);
}

export function markAllRead(uid, ids) {
  const entry = getEntry(uid);
  ids.forEach((id) => entry.readIds.add(id));
  return persist(uid);
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
  return persist(uid);
}
