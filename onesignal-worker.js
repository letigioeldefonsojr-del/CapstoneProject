// ====================================================================
// ONESIGNAL NOTIFICATION — Cloudflare Worker
// ----------------------------------------------------------------
// OneSignal's REST API Key is effectively a password for your OneSignal
// account, so it lives here as a Worker secret (ONESIGNAL_REST_API_KEY)
// and never in browser code. The admin site calls this Worker instead
// of OneSignal directly.
//
// TWO MODES (decided by the JSON body):
//
// 1) ORDER STATUS PUSH — { targetUid, title, message }
//    Targets one customer through OneSignal's External User ID.
//    Requires the same staff sign-in as promotions (see below).
//
// 2) PROMOTION PUSH (new) — { type: "promotion", message, title? }
//    Sent to every device tagged promotions_enabled = "true" (the
//    customer app keeps that tag in sync with the customer's
//    "Promotions & Offers" setting). Because this reaches EVERYONE, it
//    requires a Firebase sign-in: the request must carry
//    "Authorization: Bearer <Firebase ID token>" and that account must
//    have an admins/{uid} or employees/{uid} document.
//    `data` is { type: "promotion" } with NO orderId, so tapping the
//    push opens the app's Home tab, not Orders.
//
// SETUP (Cloudflare dashboard → this Worker → Settings → Variables):
//   ONESIGNAL_REST_API_KEY  (secret)  — already set for order pushes
//   FIREBASE_API_KEY        (text)    — the public apiKey from
//                                       firebase-config.js (used only to
//                                       verify the caller's ID token)
//
// NOTE: the Authorization scheme is "Key", not "Basic" — OneSignal's own
// 401 told us so when order pushes were first set up.
// ====================================================================
const ONESIGNAL_APP_ID = "c3b735fb-99e4-49be-8f63-e8606b95d918";
// Addresses the admin site is served from. The Worker echoes back the
// caller's origin only when it is on this list.
const ALLOWED_ORIGINS = [
  "https://capstoneproject-403.pages.dev",
  "https://capstoneproject.eldefonsojrletigio.workers.dev"
];
const FIREBASE_PROJECT_ID = "almares-328-database";

const DEFAULT_TITLE = "Almares 328";
const MAX_MESSAGE_LENGTH = 300;
const MAX_TITLE_LENGTH = 60;

export default {
  async fetch(request, env) {
    corsHeaders(request); // remember this request's origin for every response below
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, request);
    }

    let body;
    try {
      body = await request.json();
    } catch (error) {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    if (body && body.type === "promotion") {
      return handlePromotion(request, env, body);
    }
    return handleOrderPush(request, env, body);
  }
};

// ---------- Mode 1: single customer (order status) ------------------
async function handleOrderPush(request, env, body) {
  const { targetUid, title, message } = body || {};
  if (!targetUid || !message) {
    return jsonResponse({ error: "Missing targetUid or message" }, 400);
  }
  if (typeof message !== "string" || message.length > MAX_MESSAGE_LENGTH) {
    return jsonResponse({ error: "Invalid message." }, 400);
  }

  // Order updates are sent by staff from the Orders page, so require the
  // same staff sign-in as promotions — otherwise anyone could push fake
  // order updates to any customer.
  const auth = await verifyStaff(request, env);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  return sendToOneSignal(env, {
    include_external_user_ids: [targetUid],
    headings: { en: title || DEFAULT_TITLE },
    contents: { en: message }
  });
}

// ---------- Mode 2: everyone with promotions turned on --------------
async function handlePromotion(request, env, body) {
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : DEFAULT_TITLE;

  if (!message) return jsonResponse({ error: "Missing message" }, 400);
  if (message.length > MAX_MESSAGE_LENGTH) {
    return jsonResponse({ error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).` }, 400);
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return jsonResponse({ error: `Title is too long (max ${MAX_TITLE_LENGTH} characters).` }, 400);
  }

  const auth = await verifyStaff(request, env);
  if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status);

  return sendToOneSignal(env, {
    filters: [{ field: "tag", key: "promotions_enabled", relation: "=", value: "true" }],
    headings: { en: title },
    contents: { en: message },
    // Deliberately no orderId — the app uses its presence to route to Orders.
    data: { type: "promotion" }
  });
}

// Checks the Firebase ID token, then that the account is staff.
// Firestore REST is called WITHOUT the user's token on purpose: admins/
// and employees/ are publicly readable by your rules, so no service
// account is needed.
async function verifyStaff(request, env) {
  const header = request.headers.get("Authorization") || "";
  const idToken = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!idToken) return { ok: false, status: 401, error: "Sign in required." };
  if (!env.FIREBASE_API_KEY) {
    return { ok: false, status: 500, error: "Worker is missing the FIREBASE_API_KEY variable." };
  }

  let uid;
  try {
    const lookup = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_API_KEY)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken })
      }
    );
    if (!lookup.ok) return { ok: false, status: 401, error: "Your session expired. Sign in again." };
    const data = await lookup.json();
    uid = data.users && data.users[0] && data.users[0].localId;
  } catch (error) {
    return { ok: false, status: 502, error: "Couldn't verify your sign-in right now." };
  }
  if (!uid) return { ok: false, status: 401, error: "Sign in required." };

  for (const collectionName of ["admins", "employees"]) {
    try {
      const res = await fetch(
        `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collectionName}/${encodeURIComponent(uid)}`
      );
      if (res.ok) return { ok: true, uid };
    } catch (error) {
      return { ok: false, status: 502, error: "Couldn't verify your account right now." };
    }
  }
  return { ok: false, status: 403, error: "Only staff accounts can send promotions." };
}

async function sendToOneSignal(env, payload) {
  let osResponse;
  try {
    osResponse = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": `Key ${env.ONESIGNAL_REST_API_KEY}`
      },
      body: JSON.stringify({ app_id: ONESIGNAL_APP_ID, ...payload })
    });
  } catch (error) {
    return jsonResponse({ error: "Couldn't reach OneSignal right now." }, 502);
  }

  const osData = await osResponse.json().catch(() => ({}));
  if (!osResponse.ok) {
    return jsonResponse({ error: "OneSignal returned an error.", detail: osData, status: osResponse.status }, 502);
  }
  return jsonResponse({ success: true, result: osData });
}

let currentOrigin = "";

function corsHeaders(request) {
  if (request) currentOrigin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(currentOrigin) ? currentOrigin : ALLOWED_ORIGINS[0],
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function jsonResponse(data, status = 200, request) {
  if (request) corsHeaders(request);
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}
