// ====================================================================
// PER-USER READ / CLEARED TRACKING
// ----------------------------------------------------------------
// Two separate concepts, both scoped to the signed-in user's UID
// (not just the browser) so testing Admin and Employee in the same
// browser never bleeds state between them:
//
//   READ    — cosmetic only. Removes the bold/dot. Item still shows.
//   CLEARED — the item is hidden from that user's view entirely.
//
// This is deliberately client-side (localStorage) rather than a
// Firestore write, because employeeNotifications is a SHARED
// collection — every employee (and now admin) reads the same docs.
// If "Clear All" deleted the document, it would vanish for everyone,
// not just the person who clicked it. Marking it cleared FOR THIS
// UID only is what makes "I cleared mine, you still see yours" work.
//
// Every function takes uid as its first argument on purpose — it's a
// reminder at every call site that this state is per-account, not
// global to the browser.
// ====================================================================

function readKey(uid) { return `almares_read_ids_${uid}`; }
function clearedKey(uid) { return `almares_cleared_ids_${uid}`; }

function getSet(key) {
  try {
    const raw = localStorage.getItem(key);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch (error) {
    return new Set();
  }
}

function saveSet(key, set) {
  try {
    localStorage.setItem(key, JSON.stringify([...set]));
  } catch (error) {
    console.error("Couldn't save notification state:", error);
  }
}

// ---- Read ----------------------------------------------------------
export function getReadSet(uid) {
  return getSet(readKey(uid));
}

export function isRead(uid, id) {
  return getReadSet(uid).has(id);
}

export function markRead(uid, id) {
  const set = getReadSet(uid);
  set.add(id);
  saveSet(readKey(uid), set);
}

export function markAllRead(uid, ids) {
  const set = getReadSet(uid);
  ids.forEach((id) => set.add(id));
  saveSet(readKey(uid), set);
}

// ---- Cleared ---------------------------------------------------------
export function getClearedSet(uid) {
  return getSet(clearedKey(uid));
}

export function isCleared(uid, id) {
  return getClearedSet(uid).has(id);
}

export function markAllCleared(uid, ids) {
  const set = getClearedSet(uid);
  ids.forEach((id) => set.add(id));
  saveSet(clearedKey(uid), set);
}
