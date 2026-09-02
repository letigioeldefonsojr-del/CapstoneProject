import { auth, db } from "./firebase-config.js";
import { promptForgotPassword } from "./ForgotPassword.js";
import { checkLoginAllowed, recordFailedAttempt, resetAttempts } from "./LoginAttempts.js";
import {
  signInWithEmailAndPassword, onAuthStateChanged, signOut,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
  GoogleAuthProvider, signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  collection, query, where, getDocs, limit, doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const ADMIN_COLLECTION = "admins";
const ADMIN_REDIRECT_URL = "Dashboard.html";
const LOGIN_PAGE_URL = "AdminLogin.html";

const EYE_OPEN_INNER = '<path d="M2 12C4 7.5 7.8 5 12 5C16.2 5 20 7.5 22 12C20 16.5 16.2 19 12 19C7.8 19 4 16.5 2 12Z" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6"/>';
const EYE_SLASH_INNER = EYE_OPEN_INNER + '<line x1="3.5" y1="20.5" x2="20.5" y2="3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>';

// If already signed in (and genuinely a valid admin), skip straight
// past the login form instead of making them log in again.
onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  try {
    const snap = await getDoc(doc(db, ADMIN_COLLECTION, user.uid));
    if (snap.exists()) {
      window.location.replace(ADMIN_REDIRECT_URL);
    }
  } catch (error) {
    console.error("Couldn't check existing session:", error);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  const formAdmin = document.getElementById("form-admin");
  const statusBox = document.getElementById("form-status");
  const googleProvider = new GoogleAuthProvider();
  let activeCountdownInterval = null;

  document.querySelectorAll(".password-toggle").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const targetId = toggle.getAttribute("data-target");
      const input = document.getElementById(targetId);
      const willBeVisible = input.type === "password";
      input.type = willBeVisible ? "text" : "password";
      toggle.querySelector(".toggle-icon").innerHTML = willBeVisible ? EYE_OPEN_INNER : EYE_SLASH_INNER;
    });
  });

  function showStatus(message, kind) {
    statusBox.textContent = message;
    statusBox.dataset.kind = kind;
    statusBox.hidden = false;
  }

  function hideStatus() {
    statusBox.hidden = true;
    statusBox.textContent = "";
  }

  function setButtonLoading(button, isLoading, idleLabel, loadingLabel) {
    button.disabled = isLoading;
    const label = button.querySelector(".login-btn__label");
    if (label) label.textContent = isLoading ? loadingLabel : idleLabel;
  }

  function formatSecondsLeft(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainderSeconds = seconds % 60;
    return `${minutes}m ${remainderSeconds}s`;
  }

  function showLockoutCountdown(submitBtn, secondsLeft) {
    if (activeCountdownInterval) clearInterval(activeCountdownInterval);
    let remaining = secondsLeft;
    submitBtn.disabled = true;

    const tick = () => {
      if (remaining <= 0) {
        clearInterval(activeCountdownInterval);
        activeCountdownInterval = null;
        submitBtn.disabled = false;
        showStatus("You can try again now.", "success");
        return;
      }
      showStatus(`Too many failed attempts. Try again in ${formatSecondsLeft(remaining)}.`, "error");
      remaining -= 1;
    };

    tick();
    activeCountdownInterval = setInterval(tick, 1000);
  }

  function looksLikeEmail(value) {
    return value.includes("@");
  }

  async function resolveLoginEmail(identifier) {
    if (looksLikeEmail(identifier)) return identifier;
    const ref = collection(db, ADMIN_COLLECTION);
    const byUsername = query(ref, where("username", "==", identifier), limit(1));
    const snapshot = await getDocs(byUsername);
    if (snapshot.empty) return null;
    return snapshot.docs[0].data().email || null;
  }

  function isWrongCredentialError(error) {
    return ["auth/wrong-password", "auth/invalid-credential", "auth/user-not-found"].includes(error.code);
  }

  function mapAuthError(error) {
    switch (error.code) {
      case "auth/invalid-email":
        return "That email address doesn't look right.";
      case "auth/user-not-found":
      case "auth/invalid-credential":
      case "auth/wrong-password":
        return "Incorrect email or password.";
      case "auth/too-many-requests":
        return "Too many attempts. Try again in a moment.";
      default:
        return "Something went wrong. Please try again.";
    }
  }

  async function handleAdminLogin(event) {
    event.preventDefault();
    hideStatus();

    const rawInput = document.getElementById("admin-email").value.trim();
    const password = document.getElementById("admin-password").value;
    const submitBtn = document.getElementById("admin-submit");

    if (!rawInput || !password) {
      showStatus("Enter both email/username and password.", "error");
      return;
    }

    const lockStatus = await checkLoginAllowed(rawInput);
    if (!lockStatus.allowed) {
      if (lockStatus.secondsLeft) {
        showLockoutCountdown(submitBtn, lockStatus.secondsLeft);
      } else {
        showStatus(lockStatus.message, "error");
      }
      return;
    }

    setButtonLoading(submitBtn, true, "Login", "Signing in...");

    try {
      const email = await resolveLoginEmail(rawInput);
      if (!email) {
        const result = await recordFailedAttempt(rawInput);
        if (result.secondsLeft) {
          showLockoutCountdown(submitBtn, result.secondsLeft);
        } else {
          showStatus("No account with that email or username found.", "error");
        }
        return;
      }

      const rememberMe = document.getElementById("admin-remember-me").checked;
      await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);

      await signInWithEmailAndPassword(auth, email, password);

      const adminDoc = await getDoc(doc(db, ADMIN_COLLECTION, auth.currentUser.uid));
      const adminData = adminDoc.data();
      const suspendedUntilMillis = adminData?.suspendedUntil?.toMillis?.();
      if (suspendedUntilMillis && suspendedUntilMillis > Date.now()) {
        await signOut(auth);
        showSuspensionOverlay(new Date(suspendedUntilMillis).toLocaleDateString(), adminData.suspensionReason || "");
        return;
      }

      await resetAttempts(rawInput);
      sessionStorage.setItem("almares_role", "admin");
      showStatus("Signed in. Redirecting...", "success");
      window.location.replace(ADMIN_REDIRECT_URL);
    } catch (error) {
      if (isWrongCredentialError(error)) {
        const result = await recordFailedAttempt(rawInput);
        if (result.secondsLeft) {
          showLockoutCountdown(submitBtn, result.secondsLeft);
        } else {
          showStatus(result.message, "error");
        }
      } else {
        showStatus(mapAuthError(error), "error");
      }
    } finally {
      setButtonLoading(submitBtn, false, "Login", "Signing in...");
    }
  }

  // Google Sign-In — existing admin accounts sign in normally. A
  // first-time Google sign-in here does NOT create a new admin
  // account (admin self-signup was removed entirely) — they're
  // signed back out with a message instead.
  async function handleAdminGoogleSignIn() {
    const btn = document.getElementById("admin-google-btn");
    btn.disabled = true;
    hideStatus();

    try {
      const result = await signInWithPopup(auth, googleProvider);
      const user = result.user;
      const existingDoc = await getDoc(doc(db, ADMIN_COLLECTION, user.uid));

      if (existingDoc.exists()) {
        const data = existingDoc.data();
        const suspendedUntilMillis = data.suspendedUntil?.toMillis?.();
        if (suspendedUntilMillis && suspendedUntilMillis > Date.now()) {
          await signOut(auth);
          showSuspensionOverlay(new Date(suspendedUntilMillis).toLocaleDateString(), data.suspensionReason || "");
          return;
        }

        sessionStorage.setItem("almares_role", "admin");
        showStatus("Signed in. Redirecting...", "success");
        window.location.replace(ADMIN_REDIRECT_URL);
        return;
      }

      await signOut(auth);
      showStatus("Admin accounts can't be created this way. Ask an existing admin to add you from the Accounts page.", "error");
    } catch (error) {
      if (error.code === "auth/popup-closed-by-user" || error.code === "auth/cancelled-popup-request") {
        // They just closed the popup — not a real error, nothing to show.
      } else {
        console.error("Google sign-in failed:", error);
        showStatus("Google sign-in failed. Please try again.", "error");
      }
    } finally {
      btn.disabled = false;
    }
  }

  formAdmin.addEventListener("submit", handleAdminLogin);
  document.getElementById("admin-google-btn").addEventListener("click", handleAdminGoogleSignIn);
  document.querySelectorAll(".forgot-password-btn").forEach((btn) => {
    btn.addEventListener("click", () => promptForgotPassword());
  });

  // If Sidebar.js just signed someone out mid-session because their
  // account got suspended while they were actively using the app,
  // show them why instead of silently dropping them on a blank form.
  const urlParams = new URLSearchParams(window.location.search);
  const suspendedUntil = urlParams.get("suspended");
  if (suspendedUntil) {
    showSuspensionOverlay(suspendedUntil, urlParams.get("reason") || "");
  }
});

function showSuspensionOverlay(untilDate, reason) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay suspension-overlay";
  overlay.innerHTML = `
    <div class="suspension-card">
      <div class="suspension-card__icon">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7"/>
          <path d="M12 8V13" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
          <circle cx="12" cy="16.3" r="0.9" fill="currentColor"/>
        </svg>
      </div>
      <h3>This Account is Suspended</h3>
      <p class="suspension-card__row"><strong>Reason:</strong> ${reason ? escapeHtmlSuspension(reason) : "Not specified"}</p>
      <p class="suspension-card__row"><strong>Suspended until:</strong> ${escapeHtmlSuspension(untilDate)}</p>
      <p class="suspension-card__note">Contact an administrator if you believe this is a mistake.</p>
      <button type="button" class="btn-primary" id="suspension-dismiss-btn">Okay</button>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector("#suspension-dismiss-btn").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) overlay.remove();
  });

  if (window.history.replaceState) {
    window.history.replaceState({}, "", window.location.pathname);
  }
}

function escapeHtmlSuspension(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
