import { db } from "./firebase-config.js";
import {
  doc, getDoc, setDoc, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ====================================================================
// LOGIN ATTEMPT TRACKING / ESCALATING LOCKOUT
// ----------------------------------------------------------------
// Tracked by whatever identifier the person actually typed (email for
// Administrator, username for Employee) — checked BEFORE attempting
// Firebase sign-in, so a locked-out attempt never even reaches
// Firebase Auth.
//
// Schedule: 30s after the 1st failure, doubling each time after
// (60s, 120s, 240s...). After more than 15 total failures, the
// account is locked outright until an admin clears it.
//
// IMPORTANT HONEST LIMIT: this is an app-level lock only. It stops
// someone from signing in through THIS web app's UI. It does NOT
// disable the actual Firebase Authentication account — that flag can
// only be set by the Firebase Admin SDK, which runs server-side (a
// Cloud Function), not from a static web app talking to Firestore/
// Auth directly. A true "disable this account everywhere" feature
// would need one built. This still fully stops brute-force attempts
// against THIS app, which is the realistic threat model here.
// ====================================================================
const COLLECTION = "loginAttempts";
const FREE_ATTEMPTS = 6; // first N failures show a plain error, no lockout at all
const BASE_LOCKOUT_SECONDS = 30;
const PERMANENT_LOCK_THRESHOLD = 15; // more than this many TOTAL failures = locked until admin clears it

function normalizeKey(identifier) {
  return identifier.trim().toLowerCase();
}

function attemptDocRef(identifier) {
  return doc(db, COLLECTION, normalizeKey(identifier));
}

export async function checkLoginAllowed(identifier) {
  try {
    const snap = await getDoc(attemptDocRef(identifier));
    if (!snap.exists()) return { allowed: true };

    const data = snap.data();

    if (data.permanentlyLocked) {
      return {
        allowed: false,
        message: "This account has been locked after too many failed attempts. Contact an administrator to unlock it."
      };
    }

    const lockedUntilMillis = data.lockedUntil?.toMillis?.();
    if (lockedUntilMillis && Date.now() < lockedUntilMillis) {
      const secondsLeft = Math.ceil((lockedUntilMillis - Date.now()) / 1000);
      return {
        allowed: false,
        secondsLeft,
        message: `Too many failed attempts. Try again in ${formatWait(secondsLeft)}.`
      };
    }

    return { allowed: true };
  } catch (error) {
    console.error("Couldn't check login attempt status:", error);
    // Fail open — a broken check here shouldn't lock legitimate users
    // out entirely; the actual password check still has to pass.
    return { allowed: true };
  }
}

export async function recordFailedAttempt(identifier) {
  const ref = attemptDocRef(identifier);
  try {
    const snap = await getDoc(ref);
    const previousCount = snap.exists() ? (snap.data().failedCount || 0) : 0;
    const failedCount = previousCount + 1;
    const permanentlyLocked = failedCount > PERMANENT_LOCK_THRESHOLD;

    // Still within the free grace period — track the count, but no
    // lockout yet at all.
    if (failedCount <= FREE_ATTEMPTS && !permanentlyLocked) {
      await setDoc(ref, {
        identifier: normalizeKey(identifier),
        failedCount,
        lockedUntil: null,
        permanentlyLocked: false,
        lastAttemptAt: serverTimestamp()
      });

      const remaining = FREE_ATTEMPTS - failedCount;
      return {
        message: remaining > 0
          ? `Incorrect email or password. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining before a wait is required.`
          : "Incorrect email or password."
      };
    }

    // Past the grace period — escalating lockout starts counting from
    // the first failure AFTER the free attempts, not from failure #1.
    const lockoutSeconds = BASE_LOCKOUT_SECONDS * Math.pow(2, failedCount - FREE_ATTEMPTS - 1);

    await setDoc(ref, {
      identifier: normalizeKey(identifier),
      failedCount,
      lockedUntil: permanentlyLocked ? null : new Date(Date.now() + lockoutSeconds * 1000),
      permanentlyLocked,
      lastAttemptAt: serverTimestamp()
    });

    if (permanentlyLocked) {
      return { message: "This account has been locked after too many failed attempts. Contact an administrator to unlock it." };
    }
    return {
      secondsLeft: lockoutSeconds,
      message: `Incorrect email or password. Try again in ${formatWait(lockoutSeconds)}.`
    };
  } catch (error) {
    console.error("Couldn't record failed login attempt:", error);
    return { message: "Incorrect email or password." };
  }
}

export async function resetAttempts(identifier) {
  try {
    await deleteDoc(attemptDocRef(identifier));
  } catch (error) {
    // Non-fatal — a leftover record just means the next failed
    // attempt (if any) starts counting from whatever was there.
    console.error("Couldn't reset login attempt record:", error);
  }
}

function formatWait(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `${hours} hr`;
}