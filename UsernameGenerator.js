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
export async function generateUniqueUsername(fullName) {
  const base = fullName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 20) || "user";

  let candidate = base;
  let suffix = 0;

  while (await usernameExists(candidate)) {
    suffix += 1;
    candidate = `${base}${suffix}`;
  }

  return candidate;
}

async function usernameExists(username) {
  const [adminMatch, employeeMatch] = await Promise.all([
    getDocs(query(collection(db, "admins"), where("username", "==", username), limit(1))),
    getDocs(query(collection(db, "employees"), where("username", "==", username), limit(1)))
  ]);
  return !adminMatch.empty || !employeeMatch.empty;
}
