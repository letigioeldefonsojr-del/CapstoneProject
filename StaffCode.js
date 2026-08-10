import { db } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ====================================================================
// STAFF CODE
// ----------------------------------------------------------------
// A single shared code (not per-person) that gates who can even
// attempt registration — admin can rotate it if it ever leaks, by
// updating the "code" field on staffCode/config in Firestore. There's
// no in-app UI to edit this yet; it's set directly in the Firestore
// console for now (Settings/Dashboard tooling could add that later
// if it becomes a frequent need).
// ====================================================================
export async function verifyStaffCode(enteredCode) {
  try {
    const snap = await getDoc(doc(db, "staffCode", "config"));
    if (!snap.exists() || !snap.data().code) {
      // No code configured yet — fail closed rather than silently
      // letting anyone through because nothing was set up.
      return { valid: false, message: "Staff code isn't configured yet. Contact an administrator." };
    }

    const isValid = enteredCode.trim() === snap.data().code;
    return isValid
      ? { valid: true, message: "" }
      : { valid: false, message: "Incorrect staff code." };
  } catch (error) {
    console.error("Couldn't verify staff code:", error);
    return { valid: false, message: "Couldn't verify the staff code right now. Please try again." };
  }
}
