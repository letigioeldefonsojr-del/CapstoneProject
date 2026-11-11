// username — Auto-generated unique usernames.

import { guardCall } from "./LoginGuard.js?v=20261030d";

export async function generateUniqueUsername(fullName, variantIndex = 0) {
  const bases = buildCandidateBases(fullName);
  const base = bases[variantIndex % bases.length];
  const digitCount = 2 + (variantIndex % 3); // varies the number length a bit too (2, 3, or 4 digits)

  for (let round = 0; round < 4; round += 1) {
    const candidates = Array.from(new Set(Array.from({ length: 8 }, () => `${base}${randomNumber(digitCount + round)}`)));
    const taken = new Set(await takenUsernames(candidates));
    const free = candidates.find((name) => !taken.has(name));
    if (free) return free;
  }

  const fallbacks = Array.from({ length: 12 }, (_, i) => `${base}${i + 1}`);
  const takenFallback = new Set(await takenUsernames(fallbacks));
  return fallbacks.find((name) => !takenFallback.has(name)) || `${base}${randomNumber(6)}`;
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

async function takenUsernames(names) {
  const result = await guardCall("username_taken", { names });
  return result.taken || [];
}

async function usernameExists(username) {
  return (await takenUsernames([username])).includes(username);
}
