// change-password — Lets a signed-in user change their own password.

import { auth } from "./firebase-config.js";
import { EmailAuthProvider, reauthenticateWithCredential, updatePassword } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { validatePasswordStrength } from "./PasswordStrength.js";

export function promptChangePassword(user) {
  const hasPassword = user.providerData.some((p) => p.providerId === "password");
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  const field = (id, label, auto) => `
    <div class="form-field" style="margin-top: 12px;">
      <label for="${id}">${label}</label>
      <input type="password" id="${id}" autocomplete="${auto}">
    </div>`;

  overlay.innerHTML = `
    <div class="modal">
      <div class="modal__header">
        <h3>Change password</h3>
        <button type="button" class="modal__close" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      <div class="modal__body">
        ${hasPassword
          ? field("cp-current", "Current password", "current-password") +
            field("cp-new", "New password", "new-password") +
            field("cp-confirm", "Confirm new password", "new-password")
          : `<p class="confirm-dialog__message">This account signs in with Google, so it has no password to change.</p>`}
        <p class="form-status" id="cp-status" hidden></p>
      </div>
      <div class="modal__footer">
        <button type="button" class="btn-outline" data-action="cancel">${hasPassword ? "Cancel" : "Close"}</button>
        ${hasPassword ? `<button type="button" class="btn-primary" data-action="save">Change password</button>` : ""}
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector(".modal__close").addEventListener("click", close);
  overlay.querySelector('[data-action="cancel"]').addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  if (!hasPassword) return;

  const status = overlay.querySelector("#cp-status");
  const saveBtn = overlay.querySelector('[data-action="save"]');
  const show = (msg, kind) => { status.textContent = msg; status.dataset.kind = kind; status.hidden = false; };
  overlay.querySelector("#cp-current").focus();

  saveBtn.addEventListener("click", async () => {
    const current = overlay.querySelector("#cp-current").value;
    const next = overlay.querySelector("#cp-new").value;
    const confirm = overlay.querySelector("#cp-confirm").value;
    status.hidden = true;

    if (!current || !next || !confirm) return show("Fill in all three fields.", "error");
    if (next !== confirm) return show("The new passwords don't match.", "error");
    if (next === current) return show("The new password must be different from the current one.", "error");
    const check = validatePasswordStrength(next, user.displayName || "");
    if (!check.valid) return show(check.message, "error");

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";
    try {
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, current));
      await updatePassword(auth.currentUser || user, next);
      show("Password changed.", "success");
      saveBtn.textContent = "Done";
      setTimeout(close, 1200);
    } catch (error) {
      console.error("Change password failed:", error);
      const wrong = error.code === "auth/wrong-password" || error.code === "auth/invalid-credential";
      show(
        wrong ? "Current password is incorrect."
          : error.code === "auth/too-many-requests" ? "Too many attempts. Try again in a moment."
          : "Couldn't change the password. Please try again.",
        "error"
      );
      saveBtn.disabled = false;
      saveBtn.textContent = "Change password";
    }
  });
}
