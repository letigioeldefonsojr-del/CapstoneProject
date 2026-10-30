import { guardCall } from "./LoginGuard.js?v=20261030d";

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

  // The server answers for a whole batch of candidates at once (the
  // username records can't be read from the browser any more), so a few
  // batches replace the old one-lookup-at-a-time loop.
  for (let round = 0; round < 4; round += 1) {
    const candidates = Array.from(new Set(Array.from({ length: 8 }, () => `${base}${randomNumber(digitCount + round)}`)));
    const taken = new Set(await takenUsernames(candidates));
    const free = candidates.find((name) => !taken.has(name));
    if (free) return free;
  }

  // Extremely unlikely fallback if every random try collided —
  // guarantees termination with something still unique.
  const fallbacks = Array.from({ length: 12 }, (_, i) => `${base}${i + 1}`);
  const takenFallback = new Set(await takenUsernames(fallbacks));
  return fallbacks.find((name) => !takenFallback.has(name)) || `${base}${randomNumber(6)}`;
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

async function takenUsernames(names) {
  const result = await guardCall("username_taken", { names });
  return result.taken || [];
}

async function usernameExists(username) {
  return (await takenUsernames([username])).includes(username);
}
