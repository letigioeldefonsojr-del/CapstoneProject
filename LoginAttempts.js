// lockout — Escalating login lockout tracking and unlocking.

import { guardCall } from "./LoginGuard.js?v=20261030c";

const LOCKED_MESSAGE = "This account has been locked after too many failed attempts. Contact an administrator to unlock it.";
const FREE_ATTEMPTS = 6;

export async function checkLoginAllowed(identifier) {
  try {
    const r = await guardCall("check", { id: identifier });
    if (r.state === "locked") {
      return { allowed: false, locked: true, message: LOCKED_MESSAGE };
    }
    if (r.state === "wait") {
      return {
        allowed: false,
        secondsLeft: r.secondsLeft,
        message: `Too many failed attempts. Try again in ${formatWait(r.secondsLeft)}.`
      };
    }
    return { allowed: true };
  } catch (error) {
    console.error("Couldn't check login attempt status:", error);
    return { allowed: true };
  }
}

export async function recordFailedAttempt(identifier) {
  try {
    const r = await guardCall("fail", { id: identifier });
    if (r.locked) return { locked: true, message: LOCKED_MESSAGE };
    if (r.secondsLeft) {
      return {
        secondsLeft: r.secondsLeft,
        message: `Incorrect email or password. Try again in ${formatWait(r.secondsLeft)}.`
      };
    }
    const remaining = r.remaining ?? FREE_ATTEMPTS - (r.failedCount || 0);
    return {
      message: remaining > 0
        ? `Incorrect email or password. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining before a wait is required.`
        : "Incorrect email or password."
    };
  } catch (error) {
    console.error("Couldn't record failed login attempt:", error);
    return { message: "Incorrect email or password." };
  }
}

export async function resetAttempts() {
  try {
    await guardCall("reset", {}, { signedIn: true });
  } catch (error) {
    console.error("Couldn't reset login attempt record:", error);
  }
}

// Administrators only (Accounts page): which of these identifiers are locked right now.
export async function listLocks(identifiers) {
  const r = await guardCall("status", { ids: identifiers }, { signedIn: true });
  return r.locked || [];
}

// Administrators only (Accounts page): clears a lock. Throws if it didn't work.
export async function unlockAccount(identifier) {
  await guardCall("unlock", { id: identifier }, { signedIn: true });
}

function formatWait(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `${hours} hr`;
}
