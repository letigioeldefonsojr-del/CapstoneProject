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
//   resolve_login { kind, id }   anyone   -> the email (and, for staff, status) behind a typed username
//   username_taken { names }     anyone   -> which of these usernames already exist
//   find_accounts { term }       anyone   -> matching admin/employee accounts, email masked
//   send_reset { role, id }      anyone   -> sends that account's password-reset email (5 per hour)
//   reset      {}                signed in -> clears the signed-in person's OWN records only
//   status     { ids: [...] }    admin    -> which of these identifiers are locked
//   unlock     { id }            admin    -> clears that identifier's record
import { createClient } from "npm:@supabase/supabase-js@2";
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from "npm:jose@5";

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


// ---------------------------------------------------------------------
// Reading the admins / employees records on behalf of people who are not
// signed in yet (login by username, forgot password, sign-up checks).
// The browser can no longer read those collections; this function does it
// with a READ-ONLY Google service account (Cloud Datastore Viewer role),
// stored as the Supabase secret FIREBASE_SERVICE_ACCOUNT, and only ever
// hands back the few fields each screen needs.
// ---------------------------------------------------------------------
const API_KEY = Deno.env.get("FIREBASE_API_KEY") ?? "AIzaSyBDu3L3v2iegBJbT618oQF0-_hwpiSXYn4";
const RESET_URL = Deno.env.get("RESET_PASSWORD_URL") ?? "https://capstoneproject-403.pages.dev/ResetPassword.html";
const SITE_ORIGIN = new URL(RESET_URL).origin + "/";
const SA = (() => { try { return JSON.parse(Deno.env.get("FIREBASE_SERVICE_ACCOUNT") ?? ""); } catch { return null; } })();
const FS = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

let saCache: { token: string; exp: number } | null = null;
async function serviceToken(): Promise<string> {
  if (!SA?.client_email || !SA?.private_key) throw new Error("service_account_missing");
  if (saCache && saCache.exp > Date.now() + 60_000) return saCache.token;
  const key = await importPKCS8(SA.private_key, "RS256");
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/datastore" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(SA.client_email)
    .setSubject(SA.client_email)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt()
    .setExpirationTime("55m")
    .sign(key);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error("service_token_failed");
  saCache = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return saCache.token;
}

type FsDoc = { name: string; fields?: Record<string, any> };
const docId = (d: FsDoc) => d.name.split("/").pop() as string;
const fStr = (d: FsDoc, k: string) => String(d.fields?.[k]?.stringValue ?? "");
const fBool = (d: FsDoc, k: string): boolean | null =>
  d.fields?.[k]?.booleanValue === undefined ? null : d.fields[k].booleanValue === true;
const fMs = (d: FsDoc, k: string): number | null => {
  const t = d.fields?.[k]?.timestampValue;
  return t ? Date.parse(t) : null;
};

async function fsEqual(collectionId: string, field: string, value: string): Promise<FsDoc | null> {
  const t = await serviceToken();
  const res = await fetch(`${FS}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId }],
        where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: { stringValue: value } } },
        limit: 1,
      },
    }),
  });
  if (!res.ok) throw new Error(`firestore_${res.status}`);
  const rows = await res.json();
  const hit = (rows as any[]).find((r) => r.document);
  return hit ? hit.document : null;
}

async function fsList(collectionId: string): Promise<FsDoc[]> {
  const t = await serviceToken();
  const out: FsDoc[] = [];
  let pageToken = "";
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${FS}/${collectionId}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    if (!res.ok) throw new Error(`firestore_${res.status}`);
    const j = await res.json();
    out.push(...(j.documents ?? []));
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return out;
}

async function fsGet(path: string): Promise<FsDoc | null> {
  const t = await serviceToken();
  const res = await fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${t}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`firestore_${res.status}`);
  return await res.json();
}

// Counts a call against a per-key allowance: `free` calls, then waits that double from `base`.
// Returns 0 when allowed, otherwise the seconds to wait.
async function throttle(key: string, free: number, base: number, staleMin = 15): Promise<number> {
  const { data: gate } = await admin.rpc("guard_check", { k: key, stale_min: staleMin });
  if (gate?.state === "wait") return gate.secondsLeft ?? base;
  if (gate?.state === "locked") return 3600;
  await admin.rpc("guard_fail", { k: key, free, base, perm: 100000, stale_min: staleMin });
  return 0;
}

function maskEmail(email: string) {
  const at = email.indexOf("@");
  if (at === -1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const maskedLocal = local.length <= 2 ? local[0] + "*" : local.slice(0, 2) + "*".repeat(Math.max(local.length - 2, 1));
  const dot = domain.indexOf(".");
  const dn = dot === -1 ? domain : domain.slice(0, dot);
  const rest = dot === -1 ? "" : domain.slice(dot);
  const maskedDn = dn.length <= 2 ? dn[0] + "*" : dn.slice(0, 2) + "*".repeat(Math.max(dn.length - 2, 1));
  return `${maskedLocal}@${maskedDn}${rest}`;
}

function matchesSearch(d: FsDoc, nameValue: string, term: string, phoneTerm: string) {
  const username = fStr(d, "username").toLowerCase();
  const email = fStr(d, "email").toLowerCase();
  const phone = fStr(d, "phone").replace(/\D/g, "");
  const name = nameValue.toLowerCase();
  if (username && username === term) return true;
  if (email && email === term) return true;
  if (phoneTerm && phone && phone === phoneTerm) return true;
  if (name && term.length >= 3 && name.includes(term)) return true;
  return false;
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

    // ---- Username / email lookups for the login pages (the browser can't read those records any more) ----
    if (action === "resolve_login") {
      const kind = String(body.kind ?? "");
      const id = String(body.id ?? "").trim();
      if (!id || id.length > 200 || (kind !== "admin" && kind !== "employee")) return json({ error: "bad_request" }, 400);
      const wait = await throttle(`lookup:${callerIp(req)}`, 40, 30);
      if (wait) return json({ error: "slow_down", secondsLeft: wait }, 429);

      if (kind === "admin") {
        const d = await fsEqual("admins", "username", id);
        return json({ found: !!d, email: d ? fStr(d, "email") || null : null });
      }
      const d = id.includes("@") ? await fsEqual("employees", "email", id) : await fsEqual("employees", "username", id);
      if (!d) return json({ found: false });
      return json({
        found: true,
        id: docId(d),
        email: fStr(d, "email") || null,
        activated: fBool(d, "activated") === true,
        approved: fBool(d, "approved"),
        isDriver: fBool(d, "isDriver") === true,
        suspendedUntilMs: fMs(d, "suspendedUntil"),
        suspensionReason: fStr(d, "suspensionReason"),
      });
    }

    // Sign-up: which of these usernames are already used by an admin or an employee?
    if (action === "username_taken") {
      const names: string[] = (Array.isArray(body.names) ? body.names : [])
        .slice(0, 12).map((n: unknown) => String(n ?? "").trim()).filter((n: string) => n && n.length <= 60);
      if (names.length === 0) return json({ taken: [] });
      const wait = await throttle(`names:${callerIp(req)}`, 120, 30);
      if (wait) return json({ error: "slow_down", secondsLeft: wait }, 429);
      const taken: string[] = [];
      await Promise.all(names.map(async (n) => {
        const [a, e] = await Promise.all([fsEqual("admins", "username", n), fsEqual("employees", "username", n)]);
        if (a || e) taken.push(n);
      }));
      return json({ taken });
    }

    // Forgot password, step 1: find matching accounts (email shown masked, never in full).
    if (action === "find_accounts") {
      const raw = String(body.term ?? "").trim();
      if (!raw || raw.length > 100) return json({ accounts: [] });
      const wait = await throttle(`search:${callerIp(req)}`, 20, 30);
      if (wait) return json({ error: "slow_down", secondsLeft: wait }, 429);
      const term = raw.toLowerCase();
      const phoneTerm = raw.replace(/\D/g, "");
      const [admins, employees] = await Promise.all([fsList("admins"), fsList("employees")]);
      const accounts: any[] = [];
      for (const d of admins) {
        if (matchesSearch(d, fStr(d, "name"), term, phoneTerm)) {
          accounts.push({ id: docId(d), role: "admin", name: fStr(d, "name"), maskedEmail: fStr(d, "email") ? maskEmail(fStr(d, "email")) : "" });
        }
      }
      for (const d of employees) {
        if (matchesSearch(d, fStr(d, "firstName"), term, phoneTerm)) {
          accounts.push({ id: docId(d), role: "employee", name: fStr(d, "firstName"), maskedEmail: fStr(d, "email") ? maskEmail(fStr(d, "email")) : "" });
        }
      }
      return json({ accounts: accounts.slice(0, 10) });
    }

    // Forgot password, step 2: the SERVER looks up the real email and asks Firebase to send the
    // reset link, so the full address never reaches the browser. At most 5 per address per hour.
    if (action === "send_reset") {
      const role = String(body.role ?? "");
      const id = String(body.id ?? "").trim();
      if (!id || id.length > 128 || id.includes("/") || (role !== "admin" && role !== "employee")) return json({ error: "bad_request" }, 400);
      const wait = await throttle(`resetip:${callerIp(req)}`, 15, 60);
      if (wait) return json({ error: "slow_down", secondsLeft: wait }, 429);
      const d = await fsGet(`${role === "admin" ? "admins" : "employees"}/${id}`);
      const email = d ? fStr(d, "email").trim().toLowerCase() : "";
      if (!email) return json({ error: "no_email" }, 404);

      const key = `reset:${email}`;
      const { data: gate } = await admin.rpc("guard_check", { k: key, stale_min: 60 });
      if (gate?.state === "wait") return json({ error: "limit", secondsLeft: gate.secondsLeft ?? 3600 }, 429);

      const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(API_KEY)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Referer: SITE_ORIGIN },
        body: JSON.stringify({ requestType: "PASSWORD_RESET", email, continueUrl: RESET_URL, canHandleCodeInApp: true }),
      });
      if (!res.ok) return json({ error: "send_failed" }, 502);
      // 5 sends per hour: the 5th send starts a one-hour wait.
      await admin.rpc("guard_fail", { k: key, free: 4, base: 3600, perm: 100000, stale_min: 60 });
      return json({ ok: true, maskedEmail: maskEmail(email) });
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
