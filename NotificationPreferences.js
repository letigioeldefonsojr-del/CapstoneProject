import { db } from "./firebase-config.js";
import { doc, getDoc, updateDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ====================================================================
// NOTIFICATION PREFERENCES
// ----------------------------------------------------------------
// Per-person, stored directly on their own admins/{uid} or
// employees/{uid} document under notificationPreferences — never
// affects anyone else's view. Missing/undefined defaults to "on" for
// both categories, so existing accounts (created before this feature
// existed) behave exactly as they always have until someone actually
// opens Settings and changes something.
// ====================================================================
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
