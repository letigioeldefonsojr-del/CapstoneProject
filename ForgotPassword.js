import { auth } from "./firebase-config.js";
import { sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

// ====================================================================
// FORGOT PASSWORD
// ----------------------------------------------------------------
// Uses Firebase's built-in password reset flow — sendPasswordResetEmail
// sends a real email with a reset link; the person sets a new password
// on our own custom ResetPassword.html page (see ActionCodeSettings
// below), not Firebase's default hosted page — that's what lets
// PasswordStrength.js's real rules actually apply to a reset, not
// just to signup.
//
// The Console's "Action URL" template field got locked down by a
// recent Firebase security change — it can no longer be edited
// directly (confirmed by Firebase support; they now have to set it
// manually on request). Working around that entirely by specifying
// the redirect URL programmatically instead, via ActionCodeSettings —
// a legitimate, fully-supported parameter of sendPasswordResetEmail()
// itself, independent of that broken Console setting. Still requires
// this exact domain to be listed under Authentication → Settings →
// Authorized domains (a separate, still-working setting).
//
// Deliberately shows the same success message whether or not an
// account actually exists for that email (standard security practice
// — doesn't let someone probe which emails are registered).
// ====================================================================
const RESET_PASSWORD_URL = "https://capstoneproject-403.pages.dev/ResetPassword.html";
const actionCodeSettings = {
  url: RESET_PASSWORD_URL,
  // This is the flag that actually matters here — true tells Firebase
  // to send the person straight to OUR page with the reset code
  // attached, instead of handling everything on Firebase's own
  // default hosted widget. Previously set to false, which was wrong —
  // that's why the link kept opening Firebase's page regardless of
  // the url above.
  handleCodeInApp: true
};

const POPULAR_EMAIL_DOMAINS = [
  "gmail.com", "yahoo.com", "yahoo.com.ph", "hotmail.com", "outlook.com",
  "icloud.com", "aol.com", "live.com", "msn.com", "protonmail.com"
];

function isValidEmailFormat(email) {
  // Structural check only (has an @, a domain with a dot, no spaces).
  // Can't catch a real typo in an otherwise well-formed domain (e.g.
  // "gmai.com" instead of "gmail.com") — no client-side check can,
  // since that's still a syntactically valid email address. This
  // catches genuinely malformed input: missing @, no domain, spaces,
  // etc. See suggestDomainCorrection() for the typo case.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Catches close-but-wrong domains a pure format check can't — e.g.
// "gmai.com" or "gmail.co" are each one character off from
// "gmail.com". Compares against a short list of popular providers
// using edit distance; a small distance (1-2) that ISN'T an exact
// match is almost certainly a typo, not a real alternate domain.
function suggestDomainCorrection(email) {
  const atIndex = email.lastIndexOf("@");
  if (atIndex === -1) return null;
  const domain = email.slice(atIndex + 1).toLowerCase();

  for (const popular of POPULAR_EMAIL_DOMAINS) {
    if (domain === popular) return null; // exact match — nothing to suggest
    if (levenshteinDistance(domain, popular) <= 2) return popular;
  }
  return null;
}

function levenshteinDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) rows[i][0] = i;
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = a[i - 1] === b[j - 1]
        ? rows[i - 1][j - 1]
        : 1 + Math.min(rows[i - 1][j], rows[i][j - 1], rows[i - 1][j - 1]);
    }
  }
  return rows[a.length][b.length];
}

export function promptForgotPassword() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal__header">
        <h3>Reset your password</h3>
        <button type="button" class="modal__close" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      <div class="modal__body">
        <p class="confirm-dialog__message">Enter your account email and we'll send you a link to reset your password.</p>
        <div class="form-field" style="margin-top: 14px;">
          <label for="forgot-password-email">Email</label>
          <input type="email" id="forgot-password-email" autocomplete="email">
        </div>
        <p class="form-status" id="forgot-password-status" hidden></p>
      </div>
      <div class="modal__footer">
        <button type="button" class="btn-outline" data-action="cancel">Cancel</button>
        <button type="button" class="btn-primary" data-action="send">Send Reset Link</button>
      </div>
    </div>
  `;

  const emailInput = overlay.querySelector("#forgot-password-email");
  const statusEl = overlay.querySelector("#forgot-password-status");
  const sendBtn = overlay.querySelector('[data-action="send"]');

  function close() {
    overlay.remove();
  }

  function showStatus(message, kind) {
    statusEl.textContent = message;
    statusEl.dataset.kind = kind;
    statusEl.hidden = false;
  }

  overlay.querySelector(".modal__close").addEventListener("click", close);
  overlay.querySelector('[data-action="cancel"]').addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });

  let domainWarningShown = false;
  emailInput.addEventListener("input", () => {
    domainWarningShown = false; // re-check from scratch if they edit after seeing a warning
  });

  sendBtn.addEventListener("click", async () => {
    const email = emailInput.value.trim();
    if (!email) {
      showStatus("Enter your email address.", "error");
      return;
    }
    if (!isValidEmailFormat(email)) {
      showStatus("Enter a valid email address (e.g. name@example.com).", "error");
      return;
    }

    if (!domainWarningShown) {
      const suggestion = suggestDomainCorrection(email);
      if (suggestion) {
        const localPart = email.slice(0, email.lastIndexOf("@"));
        showStatus(`Did you mean ${localPart}@${suggestion}? Click "Send Reset Link" again to use this email as typed.`, "error");
        domainWarningShown = true;
        return;
      }
    }

    sendBtn.disabled = true;
    sendBtn.textContent = "Sending...";

    try {
      await sendPasswordResetEmail(auth, email, actionCodeSettings);
      showStatus("If an account exists for that email, a reset link has been sent. Check your inbox.", "success");
      sendBtn.textContent = "Sent";
    } catch (error) {
      console.error("Couldn't send reset email:", error);
      const message = error.code === "auth/invalid-email"
        ? "That email address doesn't look right."
        : "Something went wrong. Please try again.";
      showStatus(message, "error");
      sendBtn.disabled = false;
      sendBtn.textContent = "Send Reset Link";
    }
  });

  document.body.appendChild(overlay);
  emailInput.focus();
}