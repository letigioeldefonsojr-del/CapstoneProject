// staff-code — Shared staff registration code check.

import { guardCall } from "./LoginGuard.js?v=20261030c";

export async function verifyStaffCode(enteredCode) {
  try {
    const r = await guardCall("code_check", { code: enteredCode.trim() });
    if (!r.configured) {
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
