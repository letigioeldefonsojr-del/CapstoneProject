// login-guard — Client for the login-guard Supabase function.

import { auth } from "./firebase-config.js";
import { SUPABASE_URL, SUPABASE_KEY } from "./SupabaseConfig.js";

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
