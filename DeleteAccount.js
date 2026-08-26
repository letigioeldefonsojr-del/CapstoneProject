import { auth, db } from "./firebase-config.js";
import {
  EmailAuthProvider, reauthenticateWithCredential, reauthenticateWithPopup,
  GoogleAuthProvider, deleteUser
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { doc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ====================================================================
// DELETE ACCOUNT
// ----------------------------------------------------------------
// Firebase Auth refuses deleteUser() unless the session is "recent" —
// it throws auth/requires-recent-login otherwise. Reauthentication
// here isn't just a UX confirmation step, it's what actually satisfies
// that requirement (proving it's really them, right now, not just an
// old still-valid session).
//
// WHICH reauth method to use depends on how the account actually
// signed in — checked via user.providerData, not assumed:
//   - "password" provider  → re-enter their password (the original,
//     only method this used to support)
//   - "google.com" provider → a Google confirmation popup instead,
//     since a Google-only account never has a password to check
//     against at all (this was a real gap — Delete Account was
//     unusable for Google-signed-in accounts before this)
//
// Deletes, in order: the Firestore profile doc (employees/{uid} or
// admins/{uid} depending on role), then the Auth account itself. If
// the Firestore delete succeeds but the Auth delete somehow fails,
// they'd be left signed in with no profile doc — unlikely, but worth
// knowing if you ever see someone stuck in that state.
// ====================================================================
const LOGIN_PAGE_URL = "Index.html";

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
                <svg class="icon-eye-slash" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M2 12C4 7.5 7.8 5 12 5C16.2 5 20 7.5 22 12C20 16.5 16.2 19 12 19C7.8 19 4 16.5 2 12Z" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6"/><line x1="3.5" y1="20.5" x2="20.5" y2="3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
                <svg class="icon-eye" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" hidden><path d="M2 12C4 7.5 7.8 5 12 5C16.2 5 20 7.5 22 12C20 16.5 16.2 19 12 19C7.8 19 4 16.5 2 12Z" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6"/></svg>
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
      toggle.querySelector(".icon-eye").hidden = !willBeVisible;
      toggle.querySelector(".icon-eye-slash").hidden = willBeVisible;
    });
    passwordInput.focus();
  } else {
    // Google (or other OAuth) account — confirm via a popup first;
    // Delete Account itself stays disabled until that succeeds.
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

    // Step 1: reauthenticate. If this fails, nothing has been
    // touched yet — safe to just show the error and let them retry.
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
      // Google/OAuth path — reauth already happened via the Confirm
      // button above; this just double-checks it actually succeeded
      // before doing anything permanent.
      if (!oauthReauthConfirmed) {
        showStatus(statusEl, "Please confirm with Google first.", "error");
        return;
      }
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Deleting...";
    }

    // Step 2: delete the Firestore profile doc. Reauth is already
    // verified at this point, so a failure here is a real problem —
    // but nothing about their login has changed yet.
    const profileCollection = role === "admin" ? "admins" : "employees";
    try {
      await deleteDoc(doc(db, profileCollection, user.uid));
    } catch (error) {
      console.error("Couldn't delete profile document:", error);
      showStatus(statusEl, "Couldn't remove your profile data. Please try again.", "error");
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Delete Account";
      return;
    }

    // Step 3: delete the actual login (Authentication) record — this
    // is the piece that controls whether the email/Google account can
    // sign up again fresh. If THIS specific step fails, the profile
    // from step 2 is already gone, but the login itself still exists
    // — an actionable partial state, not a silent one. Clicking
    // Delete Account again will finish it (the profile delete above
    // is a harmless no-op on an already-deleted doc, so retrying is
    // always safe).
    try {
      await deleteUser(user);
    } catch (error) {
      console.error("Profile was deleted, but deleting the login itself failed:", error);
      showStatus(
        statusEl,
        "Your profile was removed, but we couldn't finish deleting your login. Please click Delete Account one more time to finish.",
        "error"
      );
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Delete Account";
      return;
    }

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