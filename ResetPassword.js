import { auth } from "./firebase-config.js";
import {
  verifyPasswordResetCode, confirmPasswordReset
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { validatePasswordStrength } from "./PasswordStrength.js";

// ====================================================================
// CUSTOM PASSWORD RESET PAGE
// ----------------------------------------------------------------
// The link in the reset email points here (?mode=resetPassword&
// oobCode=...) instead of Firebase's default hosted reset page — see
// the setup note at the bottom of this file for the one manual step
// required in Firebase Console for that redirect to actually happen.
//
// verifyPasswordResetCode() confirms the code is real/unexpired and
// returns the associated email (for display only — it doesn't sign
// anyone in). confirmPasswordReset() is what actually changes the
// password once our own validatePasswordStrength() check has passed.
// ====================================================================
let oobCode = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode");
  oobCode = params.get("oobCode");

  if (mode !== "resetPassword" || !oobCode) {
    showInvalidLink();
    return;
  }

  try {
    const email = await verifyPasswordResetCode(auth, oobCode);
    document.getElementById("verifying-status").hidden = true;
    document.getElementById("reset-password-email").textContent = `Resetting password for ${email}`;
    document.getElementById("reset-password-form").hidden = false;
    wireForm();
  } catch (error) {
    console.error("Invalid or expired reset code:", error);
    showInvalidLink();
  }
}

function showInvalidLink() {
  document.getElementById("verifying-status").hidden = true;
  document.getElementById("invalid-link-view").hidden = false;
}

function wireForm() {
  const EYE_OPEN_INNER = '<path d="M2 12C4 7.5 7.8 5 12 5C16.2 5 20 7.5 22 12C20 16.5 16.2 19 12 19C7.8 19 4 16.5 2 12Z" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6"/>';
  const EYE_SLASH_INNER = EYE_OPEN_INNER + '<line x1="3.5" y1="20.5" x2="20.5" y2="3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>';

  document.querySelectorAll(".password-toggle").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const targetId = toggle.getAttribute("data-target");
      const input = document.getElementById(targetId);
      const willBeVisible = input.type === "password";
      input.type = willBeVisible ? "text" : "password";
      toggle.querySelector(".toggle-icon").innerHTML = willBeVisible ? EYE_OPEN_INNER : EYE_SLASH_INNER;
    });
  });

  document.getElementById("reset-password-form").addEventListener("submit", handleSubmit);
}

async function handleSubmit(event) {
  event.preventDefault();

  const statusEl = document.getElementById("reset-password-status");
  const submitBtn = document.getElementById("reset-password-submit");
  const password = document.getElementById("new-password").value;
  const confirmPassword = document.getElementById("confirm-new-password").value;

  statusEl.hidden = true;

  if (!password || !confirmPassword) {
    showStatus(statusEl, "Fill in both password fields.", "error");
    return;
  }

  if (password !== confirmPassword) {
    showStatus(statusEl, "Passwords don't match.", "error");
    return;
  }

  const strength = validatePasswordStrength(password, null);
  if (!strength.valid) {
    showStatus(statusEl, strength.message, "error");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.querySelector(".login-btn__label").textContent = "Saving...";

  try {
    await confirmPasswordReset(auth, oobCode, password);
    document.getElementById("reset-password-form").hidden = true;
    document.getElementById("reset-success-view").hidden = false;
  } catch (error) {
    console.error("Couldn't reset password:", error);
    const message = error.code === "auth/expired-action-code"
      ? "This reset link has expired. Please request a new one."
      : "Something went wrong. Please try again.";
    showStatus(statusEl, message, "error");
    submitBtn.disabled = false;
    submitBtn.querySelector(".login-btn__label").textContent = "Set New Password";
  }
}

function showStatus(el, message, kind) {
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
}

// ====================================================================
// REQUIRED ONE-TIME SETUP (Firebase Console — can't be done from code)
// ----------------------------------------------------------------
// For the emailed reset link to actually open THIS page instead of
// Firebase's default hosted one:
//   Firebase Console → Authentication → Templates → Password reset
//   → (pencil/edit icon) → Customize action URL
//   → set it to: https://<your-domain>/ResetPassword.html
// Without this step, ForgotPassword.js still works (it sends the
// email fine), but the link inside it will keep opening Firebase's
// own default page instead of this one.
// ====================================================================
