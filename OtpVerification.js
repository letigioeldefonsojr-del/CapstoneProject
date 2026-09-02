import { db } from "./firebase-config.js";
import {
  doc, setDoc, getDoc, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ====================================================================
// OTP EMAIL VERIFICATION
// ----------------------------------------------------------------
// Sent via EmailJS (client-side email sending — same approach your
// mobile app already uses). Only the Public Key is used here; the
// Private Key you shared is NOT used anywhere in this app — Private
// Keys are meant for server-side use only and should never be
// embedded in client JS, since anyone can view page source.
//
// TEMPLATE VARIABLE NAMES: confirmed directly from the EmailJS
// template's actual settings — {{passcode}} and {{time}} in the
// message body, and the "To Email" field is {{email}} (not
// {{to_email}} — that mismatch was the cause of an earlier 422 error
// from EmailJS, since it had no way to resolve a recipient).
//
// Codes expire after 10 minutes and are single-use (deleted from
// Firestore once successfully verified).
// ====================================================================
const EMAILJS_SERVICE_ID = "service_mmg4ncm";
const EMAILJS_TEMPLATE_ID = "template_szd8ssu";
const EMAILJS_PUBLIC_KEY = "D66Nq0gpzysnBwvyP";
const OTP_TTL_MINUTES = 15; // matches "valid for 15 minutes" in your actual email template

let emailjsInitialized = false;

function ensureEmailJsInitialized() {
  if (emailjsInitialized) return;
  if (!window.emailjs) {
    throw new Error("EmailJS SDK didn't load. Check the script tag in EmployeeLogin.html.");
  }
  window.emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });
  emailjsInitialized = true;
}

function generateSixDigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

export async function sendOtpCode(email, name) {
  ensureEmailJsInitialized();

  const code = generateSixDigitCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
  const ref = doc(db, "otpVerifications", normalizeEmail(email));

  await setDoc(ref, {
    code,
    email: normalizeEmail(email),
    expiresAt,
    createdAt: serverTimestamp()
  });

  // Matches your real EmailJS template exactly: {{passcode}} and
  // {{time}} in the body, {{email}} for the "To Email" field.
  // to_name is included in case your template uses it elsewhere
  // (e.g. a greeting), even though it's not shown in the body you
  // shared.
  const templateParams = {
    email: email,
    to_name: name || "",
    passcode: code,
    time: expiresAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  };

  await window.emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, templateParams);
}

export async function verifyOtpCode(email, enteredCode) {
  const ref = doc(db, "otpVerifications", normalizeEmail(email));

  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      return { valid: false, message: "No verification code found for this email. Please request a new one." };
    }

    const data = snap.data();
    const expiresAtMillis = data.expiresAt?.toMillis?.() || new Date(data.expiresAt).getTime();

    if (Date.now() > expiresAtMillis) {
      await deleteDoc(ref);
      return { valid: false, message: "This code has expired. Please request a new one." };
    }

    if (enteredCode.trim() !== data.code) {
      return { valid: false, message: "Incorrect code. Please try again." };
    }

    await deleteDoc(ref); // single-use
    return { valid: true, message: "" };
  } catch (error) {
    console.error("Couldn't verify OTP code:", error);
    return { valid: false, message: "Something went wrong verifying your code. Please try again." };
  }
}
