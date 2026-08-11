import { db } from "./firebase-config.js";
import {
  collection, query, where, getDocs, limit
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ====================================================================
// AUTO-GENERATED USERNAMES
// ----------------------------------------------------------------
// Base username derived from the full name (lowercased, spaces and
// non-alphanumeric characters stripped). If that's taken, tries
// name+1, name+2, etc. Checked against BOTH admins and employees —
// usernames are unique across the whole system, not just within one
// role, so there's never a mix-up between an admin and employee
// sharing a username.
// ====================================================================
export async function generateUniqueUsername(fullName, startSuffix = 0) {
  const base = fullName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 20) || "user";

  let suffix = startSuffix;
  let candidate = suffix === 0 ? base : `${base}${suffix}`;

  while (await usernameExists(candidate)) {
    suffix += 1;
    candidate = `${base}${suffix}`;
  }

  return candidate;
}

// Exposed so the signup form can validate a MANUALLY EDITED username
// (not just an auto-generated one) for uniqueness before submitting.
export async function isUsernameTaken(username) {
  return usernameExists(username);
}

async function usernameExists(username) {
  const [adminMatch, employeeMatch] = await Promise.all([
    getDocs(query(collection(db, "admins"), where("username", "==", username), limit(1))),
    getDocs(query(collection(db, "employees"), where("username", "==", username), limit(1)))
  ]);
  return !adminMatch.empty || !employeeMatch.empty;
}
