// username — Auto-generated unique usernames.

import { db } from "./firebase-config.js";
import {
  collection, query, where, getDocs, limit
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

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
