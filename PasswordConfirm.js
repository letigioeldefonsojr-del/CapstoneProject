import { auth } from "./firebase-config.js";
import {
  EmailAuthProvider, reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

// ====================================================================
// PASSWORD CONFIRMATION MODAL
// ----------------------------------------------------------------
// Unlike ConfirmDialog.js (a plain yes/no), this actually verifies
// the current password against Firebase Auth via
// reauthenticateWithCredential — the same mechanism DeleteAccount.js
// uses. A wrong password is rejected with an inline error and the
// modal stays open for retry; only a genuinely correct password
// resolves true. Built/torn down dynamically, same pattern as
// ConfirmDialog.js.
// ====================================================================
export function promptPasswordConfirm(message, options = {}) {
  const { title = "Confirm your password", confirmLabel = "Confirm" } = options;

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal__header">
          <h3></h3>
          <button type="button" class="modal__close" aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            </svg>
          </button>
        </div>
        <div class="modal__body">
          <p class="confirm-dialog__message"></p>
          <div class="form-field" style="margin-top: 14px;">
            <label for="pw-confirm-input">Password</label>
            <input type="password" id="pw-confirm-input" autocomplete="current-password">
          </div>
          <p class="form-status" id="pw-confirm-status" hidden></p>
        </div>
        <div class="modal__footer">
          <button type="button" class="btn-outline" data-action="cancel">Cancel</button>
          <button type="button" class="btn-danger-outline" data-action="confirm"></button>
        </div>
      </div>
    `;

    overlay.querySelector(".modal__header h3").textContent = title;
    overlay.querySelector(".confirm-dialog__message").textContent = message;
    const confirmBtn = overlay.querySelector('[data-action="confirm"]');
    confirmBtn.textContent = confirmLabel;

    const passwordInput = overlay.querySelector("#pw-confirm-input");
    const statusEl = overlay.querySelector("#pw-confirm-status");

    let settled = false;

    function cleanup(result) {
      if (settled) return;
      settled = true;
      overlay.remove();
      document.removeEventListener("keydown", onKeydown);
      resolve(result);
    }

    function onKeydown(event) {
      if (event.key === "Escape") cleanup(false);
    }

    function showStatus(msg) {
      statusEl.textContent = msg;
      statusEl.dataset.kind = "error";
      statusEl.hidden = false;
    }

    overlay.querySelector(".modal__close").addEventListener("click", () => cleanup(false));
    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => cleanup(false));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) cleanup(false);
    });
    document.addEventListener("keydown", onKeydown);

    confirmBtn.addEventListener("click", async () => {
      const password = passwordInput.value;
      if (!password) {
        showStatus("Enter your password to confirm.");
        return;
      }

      const user = auth.currentUser;
      if (!user || !user.email) {
        showStatus("Couldn't verify your session. Please log out and back in, then try again.");
        return;
      }

      confirmBtn.disabled = true;
      confirmBtn.textContent = "Verifying...";
      statusEl.hidden = true;

      try {
        const credential = EmailAuthProvider.credential(user.email, password);
        await reauthenticateWithCredential(user, credential);
        cleanup(true);
      } catch (error) {
        console.error("Password confirmation failed:", error);
        const message = (error.code === "auth/wrong-password" || error.code === "auth/invalid-credential")
          ? "Incorrect password."
          : "Something went wrong. Please try again.";
        showStatus(message);
        confirmBtn.disabled = false;
        confirmBtn.textContent = confirmLabel;
      }
    });

    document.body.appendChild(overlay);
    passwordInput.focus();
  });
}
