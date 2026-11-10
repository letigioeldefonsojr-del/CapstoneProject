// promo-push — Push notifications for promotions to opted-in customers.

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
