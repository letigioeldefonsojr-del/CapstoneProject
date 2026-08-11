import { db } from "./firebase-config.js";
import {
  doc, getDoc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ====================================================================
// RESET EMAIL RATE LIMITING
// ----------------------------------------------------------------
// Max 5 reset emails per address, per rolling 1-hour window. Once the
// 5th is sent, further requests are blocked until a full hour has
// passed since the window started — at which point the count resets
// and a fresh 5 become available.
// ====================================================================
const COLLECTION = "resetEmailAttempts";
const MAX_REQUESTS = 5;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

export async function checkResetEmailAllowed(email) {
  try {
    const snap = await getDoc(doc(db, COLLECTION, normalizeEmail(email)));
    if (!snap.exists()) return { allowed: true };

    const data = snap.data();
    const windowStartMillis = data.windowStartAt?.toMillis?.() || 0;
    const elapsed = Date.now() - windowStartMillis;

    if ((data.count || 0) >= MAX_REQUESTS && elapsed < WINDOW_MS) {
      const minutesLeft = Math.ceil((WINDOW_MS - elapsed) / 60000);
      return {
        allowed: false,
        message: `You've reached the limit of ${MAX_REQUESTS} reset emails for this account. Try again in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.`
      };
    }
    return { allowed: true };
  } catch (error) {
    console.error("Couldn't check reset email rate limit:", error);
    return { allowed: true }; // fail open — don't block a legitimate reset over a broken check
  }
}

export async function recordResetEmailSent(email) {
  const ref = doc(db, COLLECTION, normalizeEmail(email));
  try {
    const snap = await getDoc(ref);

    if (!snap.exists()) {
      await setDoc(ref, { count: 1, windowStartAt: serverTimestamp(), lastSentAt: serverTimestamp() });
      return;
    }

    const data = snap.data();
    const windowStartMillis = data.windowStartAt?.toMillis?.() || 0;
    const elapsed = Date.now() - windowStartMillis;

    if (elapsed >= WINDOW_MS) {
      // Window expired — start a fresh one.
      await setDoc(ref, { count: 1, windowStartAt: serverTimestamp(), lastSentAt: serverTimestamp() });
    } else {
      await setDoc(ref, {
        count: (data.count || 0) + 1,
        windowStartAt: data.windowStartAt,
        lastSentAt: serverTimestamp()
      });
    }
  } catch (error) {
    console.error("Couldn't record reset email send:", error);
  }
}
