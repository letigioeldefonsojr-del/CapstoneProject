// notif-prefs — Per-user notification preferences stored in Firestore.

import { db } from "./firebase-config.js";
import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const DEFAULTS = { stockAlerts: true, orderNotifications: true };

export async function getPreferences(uid, role) {
  const collectionName = role === "admin" ? "admins" : "employees";
  try {
    const snap = await getDoc(doc(db, collectionName, uid));
    const stored = snap.data()?.notificationPreferences || {};
    return { ...DEFAULTS, ...stored };
  } catch (error) {
    console.error("Couldn't load notification preferences:", error);
    return { ...DEFAULTS }; // fail open — a load error shouldn't silently mute anyone's alerts
  }
}

export async function setPreferences(uid, role, prefs) {
  const collectionName = role === "admin" ? "admins" : "employees";
  await updateDoc(doc(db, collectionName, uid), { notificationPreferences: prefs });
}
