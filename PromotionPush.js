// ====================================================================
// PROMOTION PUSH (shared helper)
// ----------------------------------------------------------------
// Sends a push to every customer who has "Promotions & Offers" turned on
// (they carry the OneSignal tag promotions_enabled = "true"). The call
// goes through the Cloudflare Worker, which holds the OneSignal key and
// checks that the caller is a signed-in staff account.
//
// Usage anywhere on the admin site:
//   import { sendPromotionPush } from "./PromotionPush.js";
//   await sendPromotionPush("🔥 Milk is now 10% off!");
//
// Never throws — a failed push must not undo the save that triggered it.
// Returns { ok: true } or { ok: false, error }.
// ====================================================================
import { auth } from "./firebase-config.js";

// Same Worker that already sends order-status pushes.
const PROMOTION_WORKER_URL = "https://onesignal-notify.eldefonsojrletigio.workers.dev";

export async function sendPromotionPush(message, { title } = {}) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return { ok: false, error: "Empty message." };

  const user = auth.currentUser;
  if (!user) return { ok: false, error: "Not signed in." };

  try {
    const idToken = await user.getIdToken();
    const response = await fetch(PROMOTION_WORKER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${idToken}`
      },
      body: JSON.stringify({ type: "promotion", message: text, ...(title ? { title } : {}) })
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      console.error("Promotion push failed:", detail);
      return { ok: false, error: (detail && detail.error) || `Worker returned ${response.status}.` };
    }
    return { ok: true };
  } catch (error) {
    console.error("Couldn't send promotion push:", error);
    return { ok: false, error: "Couldn't reach the notification service." };
  }
}

// Sends one push per item when there are only a few, otherwise a single
// summary — so applying a discount to 80 products doesn't send 80 pushes.
//   items:       array of anything
//   maxIndividual: how many separate pushes are acceptable
//   one(item):   message for a single item
//   many(items): one summary message for the whole group
export async function sendPromotionPushes(items, { maxIndividual = 3, one, many }) {
  if (!items || items.length === 0) return { ok: true, sent: 0 };

  if (items.length <= maxIndividual) {
    let sent = 0;
    for (const item of items) {
      const result = await sendPromotionPush(one(item));
      if (result.ok) sent += 1;
    }
    return { ok: sent === items.length, sent };
  }

  const result = await sendPromotionPush(many(items));
  return { ok: result.ok, sent: result.ok ? 1 : 0, error: result.error };
}
