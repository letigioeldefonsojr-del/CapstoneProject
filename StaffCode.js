import { guardCall } from "./LoginGuard.js?v=20261030d";

// ====================================================================
// STAFF CODE
// ----------------------------------------------------------------
// A single shared code (not per-person) that gates who can even
// attempt registration. It is no longer stored where the browser can
// read it: the login-guard function compares what was typed and only
// answers yes or no. To rotate the code, run the "set code" SQL at the
// bottom of supabase/09_login_guard.sql in the Supabase SQL editor.
// Too many wrong guesses from one address are slowed down on the server.
// ====================================================================
export async function verifyStaffCode(enteredCode) {
  try {
    const r = await guardCall("code_check", { code: enteredCode.trim() });
    if (!r.configured) {
      // No code configured yet - fail closed rather than silently
      // letting anyone through because nothing was set up.
      return { valid: false, message: "Staff code isn't configured yet. Contact an administrator." };
    }
    if (r.valid) return { valid: true, message: "" };
    if (r.secondsLeft) {
      return { valid: false, message: `Too many wrong codes. Try again in ${r.secondsLeft < 60 ? `${r.secondsLeft}s` : `${Math.round(r.secondsLeft / 60)} min`}.` };
    }
    return { valid: false, message: "Incorrect staff code." };
  } catch (error) {
    console.error("Couldn't verify staff code:", error);
    return { valid: false, message: "Couldn't verify the staff code right now. Please try again." };
  }
}
