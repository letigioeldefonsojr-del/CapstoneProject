import { auth } from "./firebase-config.js";
import { sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

// ====================================================================
// FORGOT PASSWORD
// ----------------------------------------------------------------
// Uses Firebase's built-in password reset flow — sendPasswordResetEmail
// sends a real email with a reset link; the person sets a new password
// on Firebase's own hosted page, no custom reset page needed here.
//
// Deliberately shows the same success message whether or not an
// account actually exists for that email (standard security practice
// — doesn't let someone probe which emails are registered).
// ====================================================================
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

  sendBtn.addEventListener("click", async () => {
    const email = emailInput.value.trim();
    if (!email) {
      showStatus("Enter your email address.", "error");
      return;
    }

    sendBtn.disabled = true;
    sendBtn.textContent = "Sending...";

    try {
      await sendPasswordResetEmail(auth, email);
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
