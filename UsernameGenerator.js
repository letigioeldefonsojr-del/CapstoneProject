import { db } from "./firebase-config.js";
import {
  collection, query, where, getDocs, limit
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ====================================================================
// AUTO-GENERATED USERNAMES
// ----------------------------------------------------------------
// Mixes different parts of the name (first name, last name, initials,
// combinations) with a random number, instead of just incrementing a
// number on the same base — so each regenerate genuinely looks
// different (e.g. "eldefonso194" then "letigio8213"), not a
// predictable "name1", "name2", "name3" sequence.
//
// variantIndex picks which name-part strategy to use (cycles through
// the available ones) — pass a different index each time you want a
// visibly different style of suggestion, e.g. incrementing it on
// every "Regenerate" click.
//
// Checked against BOTH admins and employees — usernames are unique
// across the whole system, not just within one role.
// ====================================================================
export async function generateUniqueUsername(fullName, variantIndex = 0) {
  const bases = buildCandidateBases(fullName);
  const base = bases[variantIndex % bases.length];
  const digitCount = 2 + (variantIndex % 3); // varies the number length a bit too (2, 3, or 4 digits)

  let candidate;
  let attempts = 0;

  do {
    candidate = `${base}${randomNumber(digitCount)}`;
    attempts += 1;
  } while (await usernameExists(candidate) && attempts < 25);

  // Extremely unlikely fallback if 25 random tries all somehow
  // collided — guarantees termination with something still unique.
  if (await usernameExists(candidate)) {
    let suffix = 1;
    let fallback = `${base}${suffix}`;
    while (await usernameExists(fallback)) {
      suffix += 1;
      fallback = `${base}${suffix}`;
    }
    return fallback;
  }

  return candidate;
}

// Exposed so the signup form can validate a MANUALLY EDITED username
// (not just an auto-generated one) for uniqueness before submitting.
export async function isUsernameTaken(username) {
  return usernameExists(username);
}

function buildCandidateBases(fullName) {
  const parts = fullName
    .trim()
    .split(/\s+/)
    .map((part) => part.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);

  if (parts.length === 0) return ["user"];

  const first = parts[0];
  const last = parts[parts.length - 1];
  const initials = parts.map((p) => p[0]).join("");

  const bases = [
    first,
    last,
    first + (last[0] || ""),
    last + (first[0] || ""),
    initials,
    (first.slice(0, 4) + last.slice(0, 3)) || first
  ].filter(Boolean);

  // De-duplicate while preserving order (short names can produce the
  // same base via multiple strategies, e.g. a one-word "name").
  return Array.from(new Set(bases));
}

function randomNumber(digitCount) {
  const min = Math.pow(10, digitCount - 1);
  const max = Math.pow(10, digitCount) - 1;
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function usernameExists(username) {
  const [adminMatch, employeeMatch] = await Promise.all([
    getDocs(query(collection(db, "admins"), where("username", "==", username), limit(1))),
    getDocs(query(collection(db, "employees"), where("username", "==", username), limit(1)))
  ]);
  return !adminMatch.empty || !employeeMatch.empty;
}
