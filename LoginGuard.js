import { auth } from "./firebase-config.js";
import { SUPABASE_URL, SUPABASE_KEY } from "./SupabaseConfig.js";

// ====================================================================
// LOGIN GUARD (talks to the login-guard function)
// ----------------------------------------------------------------
// The login lockout counters and the staff registration code live on the
// server, so the browser can no longer read, edit or delete them. Checks
// made before sign-in send only the public key; the ones that need to
// know who is asking (clearing your own record, admin unlock) also send
// the signed-in person's Firebase login.
// ====================================================================
export async function guardCall(action, payload = {}, { signedIn = false } = {}) {
  const headers = { "Content-Type": "application/json", apikey: SUPABASE_KEY };
  if (signedIn) {
    const user = auth.currentUser;
    if (!user) throw new Error("not_signed_in");
    headers["x-firebase-token"] = await user.getIdToken();
  }
  const res = await fetch(`${SUPABASE_URL}/functions/v1/login-guard`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action, ...payload })
  });
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok || !data || data.error) {
    throw new Error(data?.error || `http_${res.status}`);
  }
  return data;
}
