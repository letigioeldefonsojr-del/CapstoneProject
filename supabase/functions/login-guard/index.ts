// Almares 328 - Supabase Edge Function "login-guard"
// Keeps the login lockout counters and the staff registration code on the
// server, where the browser can't edit or read them.
//
// Deploy as a NEW function named "login-guard" with "Verify JWT" switched OFF
// (like store-api: the people calling it are not signed in yet; the rules
// below decide who may do what).
//
// Request: POST { "action": "...", ... }   Header: apikey (and, where noted, x-firebase-token)
//
//   check      { id }            anyone   -> { state: ok | wait | locked, secondsLeft? }
//   fail       { id }            anyone   -> { failedCount, remaining | secondsLeft | locked }
//   code_check { code }          anyone   -> { valid, configured, secondsLeft? }   (throttled per IP)
//   reset      {}                signed in -> clears the signed-in person's OWN records only
//   status     { ids: [...] }    admin    -> which of these identifiers are locked
//   unlock     { id }            admin    -> clears that identifier's record
import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "npm:jose@5";

const PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID") ?? "almares-328-database";
const jwks = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
);
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info, x-firebase-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Same normalising the site has always used: trimmed + lower case.
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
const validId = (s: string) => s.length > 0 && s.length <= 200;

async function verify(idToken: string): Promise<{ uid: string; email: string }> {
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: `https://securetoken.google.com/${PROJECT_ID}`,
    audience: PROJECT_ID,
  });
  if (!payload.sub) throw new Error("no subject");
  return { uid: payload.sub, email: norm(payload.email) };
}

// Reads a Firestore document with the caller's OWN token (so Firestore's rules still apply).
async function firestoreDoc(path: string, idToken: string) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
  if (res.status === 200) return await res.json();
  return null;
}

function tokenOf(req: Request) {
  return (req.headers.get("x-firebase-token") ?? "").replace(/^Bearer\s+/i, "");
}

async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function callerIp(req: Request) {
  const raw = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "unknown";
  return raw.split(",")[0].trim().slice(0, 64) || "unknown";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const action = String(body?.action ?? "");

  try {
    // ---------- open to anyone (used before the person is signed in) ----------
    if (action === "check") {
      const id = norm(body.id);
      if (!validId(id)) return json({ error: "bad_id" }, 400);
      const { data, error } = await admin.rpc("guard_check", { k: id });
      if (error) return json({ error: error.message }, 500);
      return json(data);
    }

    if (action === "fail") {
      const id = norm(body.id);
      if (!validId(id)) return json({ error: "bad_id" }, 400);
      const { data, error } = await admin.rpc("guard_fail", { k: id });
      if (error) return json({ error: error.message }, 500);
      return json(data);
    }

    // The registration code is compared here and only yes / no goes back.
    // Wrong guesses are counted per caller address with the same escalating waits.
    if (action === "code_check") {
      const code = String(body.code ?? "").trim();
      if (!code || code.length > 200) return json({ valid: false, configured: true });
      const key = `code:${callerIp(req)}`;
      const { data: gate } = await admin.rpc("guard_check", { k: key });
      if (gate?.state === "wait") return json({ valid: false, configured: true, secondsLeft: gate.secondsLeft });
      if (gate?.state === "locked") return json({ valid: false, configured: true, secondsLeft: 3600 });

      const { data: row } = await admin.from("staff_code").select("code_hash").eq("id", 1).maybeSingle();
      if (!row?.code_hash) return json({ valid: false, configured: false });

      if ((await sha256Hex(code)) === row.code_hash) {
        await admin.rpc("guard_reset", { ks: [key] });
        return json({ valid: true, configured: true });
      }
      const { data: failed } = await admin.rpc("guard_fail", { k: key });
      return json({ valid: false, configured: true, secondsLeft: failed?.secondsLeft ?? null });
    }

    // ---------- everything below needs a signed-in person ----------
    const token = tokenOf(req);
    if (!token) return json({ error: "not_signed_in" }, 401);
    let who: { uid: string; email: string };
    try { who = await verify(token); } catch { return json({ error: "bad_token" }, 401); }

    // After a good login: clears only the signed-in person's own records
    // (their email, and the email/username on their own profile) - never anyone else's.
    if (action === "reset") {
      const ids = new Set<string>();
      if (who.email) ids.add(who.email);
      for (const col of ["admins", "employees"]) {
        const d = await firestoreDoc(`${col}/${who.uid}`, token);
        const f = d?.fields ?? {};
        if (f.email?.stringValue) ids.add(norm(f.email.stringValue));
        if (f.username?.stringValue) ids.add(norm(f.username.stringValue));
      }
      const { error } = await admin.rpc("guard_reset", { ks: [...ids].filter(validId) });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ---------- administrators only ----------
    const isAdmin = !!(await firestoreDoc(`admins/${who.uid}`, token));
    if (!isAdmin) return json({ error: "not_admin" }, 403);

    if (action === "status") {
      const ids: string[] = (Array.isArray(body.ids) ? body.ids : []).slice(0, 20).map(norm).filter(validId);
      if (ids.length === 0) return json({ locked: [] });
      const { data, error } = await admin.rpc("guard_status", { ks: ids });
      if (error) return json({ error: error.message }, 500);
      return json({ locked: data ?? [] });
    }

    if (action === "unlock") {
      const id = norm(body.id);
      if (!validId(id)) return json({ error: "bad_id" }, 400);
      const { error } = await admin.rpc("guard_reset", { ks: [id] });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
