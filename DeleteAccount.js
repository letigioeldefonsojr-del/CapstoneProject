// delete-account — Reauthenticate and permanently delete the signed-in account.

import { auth, db } from "./firebase-config.js";
import {
  EmailAuthProvider, reauthenticateWithCredential, reauthenticateWithPopup,
  GoogleAuthProvider, deleteUser, signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { doc, deleteDoc, getDocFromServer, waitForPendingWrites } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const LOGIN_PAGE_URL = "/";

export function promptDeleteAccount(user, role) {
  const isPasswordAccount = user.providerData.some((p) => p.providerId === "password");
  const isGoogleAccount = user.providerData.some((p) => p.providerId === "google.com");

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal__header">
        <h3>Delete your account?</h3>
        <button type="button" class="modal__close" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      <div class="modal__body">
        <p class="confirm-dialog__message">This permanently deletes your account and profile. This can't be undone.</p>

        ${isPasswordAccount ? `
          <div class="form-field" style="margin-top: 14px;">
            <label for="delete-account-password">Enter your password to confirm</label>
            <div class="password-field-wrapper">
              <input type="password" id="delete-account-password" autocomplete="current-password" class="password-field-input">
              <button type="button" class="password-field-toggle" aria-label="Show password">
                <svg class="toggle-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 12C4 7.5 7.8 5 12 5C16.2 5 20 7.5 22 12C20 16.5 16.2 19 12 19C7.8 19 4 16.5 2 12Z" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6"/><line x1="3.5" y1="20.5" x2="20.5" y2="3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
              </button>
            </div>
          </div>
        ` : `
          <p class="confirm-dialog__message" style="margin-top: 14px;">
            This account signed in with ${isGoogleAccount ? "Google" : "an external provider"} — click below to confirm it's really you, then Delete Account.
          </p>
        `}

        <p class="form-status" id="delete-account-status" hidden></p>
      </div>
      <div class="modal__footer">
        <button type="button" class="btn-outline" data-action="cancel">Cancel</button>
        ${isPasswordAccount
          ? `<button type="button" class="btn-danger-outline" data-action="confirm">Delete Account</button>`
          : `<button type="button" class="btn-outline" data-action="confirm-oauth">Confirm with ${isGoogleAccount ? "Google" : "provider"}</button>
             <button type="button" class="btn-danger-outline" data-action="confirm" disabled>Delete Account</button>`
        }
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const statusEl = overlay.querySelector("#delete-account-status");
  const confirmBtn = overlay.querySelector('[data-action="confirm"]');
  let oauthReauthConfirmed = false;

  if (isPasswordAccount) {
    const passwordInput = overlay.querySelector("#delete-account-password");
    overlay.querySelector(".password-field-toggle").addEventListener("click", () => {
      const toggle = overlay.querySelector(".password-field-toggle");
      const willBeVisible = passwordInput.type === "password";
      passwordInput.type = willBeVisible ? "text" : "password";
      toggle.querySelector(".toggle-icon").innerHTML = willBeVisible
        ? '<path d="M2 12C4 7.5 7.8 5 12 5C16.2 5 20 7.5 22 12C20 16.5 16.2 19 12 19C7.8 19 4 16.5 2 12Z" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6"/>'
        : '<path d="M2 12C4 7.5 7.8 5 12 5C16.2 5 20 7.5 22 12C20 16.5 16.2 19 12 19C7.8 19 4 16.5 2 12Z" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6"/><line x1="3.5" y1="20.5" x2="20.5" y2="3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>';
    });
    passwordInput.focus();
  } else {
    overlay.querySelector('[data-action="confirm-oauth"]').addEventListener("click", async (event) => {
      const oauthBtn = event.currentTarget;
      oauthBtn.disabled = true;
      oauthBtn.textContent = "Confirming...";
      statusEl.hidden = true;

      try {
        const provider = new GoogleAuthProvider();
        await reauthenticateWithPopup(user, provider);
        oauthReauthConfirmed = true;
        oauthBtn.textContent = "Confirmed ✓";
        confirmBtn.disabled = false;
      } catch (error) {
        console.error("Reauthentication failed:", error);
        showStatus(statusEl, mapDeleteError(error), "error");
        oauthBtn.disabled = false;
        oauthBtn.textContent = `Confirm with ${isGoogleAccount ? "Google" : "provider"}`;
      }
    });
  }

  function close() {
    overlay.remove();
  }

  overlay.querySelector(".modal__close").addEventListener("click", close);
  overlay.querySelector('[data-action="cancel"]').addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  confirmBtn.addEventListener("click", async () => {
    statusEl.hidden = true;

    if (isPasswordAccount) {
      const password = overlay.querySelector("#delete-account-password").value;
      if (!password) {
        showStatus(statusEl, "Enter your password to confirm.", "error");
        return;
      }

      confirmBtn.disabled = true;
      confirmBtn.textContent = "Deleting...";

      try {
        const credential = EmailAuthProvider.credential(user.email, password);
        await reauthenticateWithCredential(user, credential);
      } catch (error) {
        console.error("Reauthentication failed:", error);
        showStatus(statusEl, mapDeleteError(error), "error");
        confirmBtn.disabled = false;
        confirmBtn.textContent = "Delete Account";
        return;
      }
    } else {
      if (!oauthReauthConfirmed) {
        showStatus(statusEl, "Please confirm with Google first.", "error");
        return;
      }
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Deleting...";
    }

    const profileCollection = role === "admin" ? "admins" : "employees";
    window.__almaresDeletingAccount = true;
    try {
      const profileRef = doc(db, profileCollection, user.uid);
      await deleteDoc(profileRef);
      await waitForPendingWrites(db); // the delete must reach the server before anything else happens
      const stillThere = await getDocFromServer(profileRef).then((s) => s.exists());
      if (stillThere) throw new Error("The profile is still on the server after delete.");
    } catch (error) {
      window.__almaresDeletingAccount = false;
      console.error("Couldn't delete profile document:", error);
      showStatus(statusEl, "Couldn't remove your profile data. Please try again.", "error");
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Delete Account";
      return;
    }

    try {
      await deleteUser(user);
    } catch (error) {
      console.error("Profile was deleted, but deleting the login itself failed:", error);
      window.__almaresDeletingAccount = false;
      showStatus(
        statusEl,
        "Your profile was removed, but we couldn't finish deleting your login. Please click Delete Account one more time to finish.",
        "error"
      );
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Delete Account";
      return;
    }

    try { await signOut(auth); } catch (_) { /* the user is already gone */ }
    sessionStorage.clear();
    window.location.href = LOGIN_PAGE_URL;
  });
}

function showStatus(el, message, kind) {
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
}

function mapDeleteError(error) {
  switch (error.code) {
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Incorrect password.";
    case "auth/too-many-requests":
      return "Too many attempts. Try again in a moment.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Confirmation was cancelled. Please try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}
