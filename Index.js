import { auth, db } from "./firebase-config.js";
import { promptForgotPassword } from "./ForgotPassword.js";
import { validatePasswordStrength } from "./PasswordStrength.js";
import { checkLoginAllowed, recordFailedAttempt, resetAttempts } from "./LoginAttempts.js";
import { verifyStaffCode } from "./StaffCode.js";
import { sendOtpCode, verifyOtpCode } from "./OtpVerification.js";
import { generateUniqueUsername, isUsernameTaken } from "./UsernameGenerator.js";
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile, onAuthStateChanged, signOut,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
  GoogleAuthProvider, signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  collection, query, where, getDocs, limit, serverTimestamp, doc, setDoc, getDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ====================================================================
// CHUNK 0 — CONFIG
// ----------------------------------------------------------------
// Employees are real Firebase Authentication accounts (this matches
// your existing Firestore rules: employees/{employeeId} only allows
// writes where request.auth.uid == employeeId, and isEmployee() checks
// employees/$(request.auth.uid) exists). Login is by username, so we
// do a public read to resolve username -> email, then sign in through
// Firebase Auth with that email. No password is ever stored in
// Firestore — Firebase Auth handles it entirely.
// Adjust these to match your actual field names in "employees".
// ====================================================================
const EMPLOYEE_COLLECTION     = "employees";
const EMPLOYEE_NAME_FIELD     = "firstName";
const EMPLOYEE_USERNAME_FIELD = "username";  // primary lookup field
const EMPLOYEE_EMAIL_FIELD    = "email";     // used to resolve to Firebase Auth
const EMPLOYEE_ACTIVE_FIELD   = "activated"; // boolean: true / false

// SECURITY NOTE: letting anyone reach this page self-register an
// Administrator account is a real risk once this is public — normally
// admin accounts are provisioned manually, not self-served. Before
// this goes live, gate CHUNK 7B behind something (an invite code
// checked server-side, an allow-listed email domain via a Cloud
// Function, or remove the admin sign-up form and create admins
// directly from the Firebase console instead).
//
// IMPORTANT — Firestore rule needed: your current rules (the ones
// you shared) have no "admins" collection, so this write WILL be
// rejected until you add a rule for it. Add this alongside your
// existing "employees" rule:
//
//   match /admins/{adminId} {
//     allow read: if true;
//     allow create, update: if isSignedIn() && request.auth.uid == adminId;
//   }
//
const ADMIN_COLLECTION = "admins";

const ADMIN_REDIRECT_URL      = "Dashboard.html";
const EMPLOYEE_REDIRECT_URL   = "Dashboard.html";

// ====================================================================
// CHUNK 0B — BOUNCE ALREADY-SIGNED-IN USERS PAST THE LOGIN FORM
// ----------------------------------------------------------------
// The dashboard's back/forward trap can only stop navigation between
// history entries WITHIN that page — clicking Back to actually load
// this page (a different document) isn't something it can intercept,
// since Dashboard.js has already been torn down by the time that
// happens. The real fix lives here instead: if someone still has an
// active Firebase Auth session and ends up on this page — Back
// button, typed URL, bookmark, doesn't matter how — send them
// straight back to the dashboard instead of showing the login form.
//
// IMPORTANT: this must only ever act on the FIRST auth-state check
// (page load), not every subsequent one — that's what
// stopWatchingInitialAuthState() is for. createUserWithEmailAndPassword
// and signInWithEmailAndPassword both trigger their own auth-state
// change internally. Without unsubscribing, this listener would fire
// again right in the middle of handleAdminSignup / handleAdminLogin
// and redirect immediately — racing against (and usually beating) that
// function's own code, which is exactly what was causing new admin
// signups to get bounced to the Dashboard before the Firestore write
// or the sessionStorage role could ever run.
// ====================================================================
const stopWatchingInitialAuthState = onAuthStateChanged(auth, (user) => {
  stopWatchingInitialAuthState(); // only care about the state at page load — see note above
  if (user) {
    window.location.replace("Dashboard.html");
  }
});

// ====================================================================
// CHUNK 1 — WAIT FOR DOM
// ====================================================================
document.addEventListener("DOMContentLoaded", () => {

  // Chrome's "Suggest a strong password" feature can keep re-filling
  // a signup password field on page reload, even when the form was
  // never actually submitted — it's the browser restoring its own
  // suggestion, not anything this app stored. Explicitly blanking
  // every password field on load overrides that, so a reload always
  // starts from a genuinely clean form.
  // A fixed timeout can't reliably catch browser autofill, since the
  // exact timing varies and can happen later than any reasonable
  // delay. This uses a well-established technique instead: browsers
  // apply a distinct internal state when autofilling a field, which
  // this hooks a CSS animation onto (see Index.css) specifically to
  // detect the REAL moment autofill happens, however late it occurs
  // — not a guess based on a fixed delay.
  //
  // Scoped to SIGNUP password fields only — a returning user's saved
  // password autofilling the LOGIN field is actually wanted behavior,
  // not something to clear. This is specifically about Chrome's
  // "suggest a strong password" persisting unwantedly on signup.
  const SIGNUP_PASSWORD_FIELD_IDS = [
    "admin-signup-password", "admin-signup-confirm-password",
    "signup-password", "signup-confirm-password"
  ];

  SIGNUP_PASSWORD_FIELD_IDS.forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.value = "";
    input.addEventListener("animationstart", (event) => {
      if (event.animationName === "onAutofillDetected") {
        input.value = "";
      }
    });
  });

  // ------------------------------------------------------------------
  // CHUNK 2 — ELEMENT REFERENCES
  // ------------------------------------------------------------------
  const tabAdmin    = document.getElementById("tab-admin");
  const tabEmployee = document.getElementById("tab-employee");
  const roleToggle  = document.getElementById("role-toggle");
  const roleThumb   = document.getElementById("role-thumb");

  const formAdmin    = document.getElementById("form-admin");
  const formAdminSignup = document.getElementById("form-admin-signup");
  const formEmployee = document.getElementById("form-employee");
  const formSignup   = document.getElementById("form-employee-signup");
  const formOtpVerify = document.getElementById("form-otp-verify");
  const formGoogleComplete = document.getElementById("form-google-complete-profile");

  // Holds the not-yet-created account's data between "passed initial
  // validation, OTP sent" and "OTP verified, actually create the
  // account" — nothing is written to Firebase Auth or Firestore until
  // the code is confirmed.
  let pendingSignup = null;
  let pendingOAuthSignup = null;
  const googleProvider = new GoogleAuthProvider();

  const toAdminSignupLink = document.getElementById("to-admin-signup");
  const toAdminLoginLink  = document.getElementById("to-admin-login");
  const toSignupLink = document.getElementById("to-signup");
  const toLoginLink  = document.getElementById("to-login");

  const statusBox = document.getElementById("form-status");
  const cardTitle = document.getElementById("card-title");

  // ------------------------------------------------------------------
  // CHUNK 3 — ROLE TOGGLE (Administrator <-> Employee)
  // ------------------------------------------------------------------
  function setActiveRole(role) {
    const isAdmin = role === "admin";

    tabAdmin.classList.toggle("is-active", isAdmin);
    tabEmployee.classList.toggle("is-active", !isAdmin);
    tabAdmin.setAttribute("aria-selected", String(isAdmin));
    tabEmployee.setAttribute("aria-selected", String(!isAdmin));

    roleThumb.style.transform = isAdmin ? "translateX(0)" : "translateX(100%)";

    hideOtpStep();
    hideGoogleCompleteProfileStep();
    pendingOAuthSignup = null;
    pendingSignup = null;

    if (isAdmin) {
      setAdminMode("login");
      formEmployee.hidden = true;
      formSignup.hidden = true;
    } else {
      formAdmin.hidden = true;
      formAdminSignup.hidden = true;
      setEmployeeMode("login");
    }

    hideStatus();
  }

  tabAdmin.addEventListener("click", () => setActiveRole("admin"));
  tabEmployee.addEventListener("click", () => setActiveRole("employee"));

  // ------------------------------------------------------------------
  // CHUNK 3A — ADMINISTRATOR LOGIN <-> CREATE ACCOUNT
  // ------------------------------------------------------------------
  function setAdminMode(mode) {
    const isLogin = mode === "login";
    hideOtpStep();
    hideGoogleCompleteProfileStep();
    pendingOAuthSignup = null;
    pendingSignup = null;
    formAdmin.hidden = !isLogin;
    formAdminSignup.hidden = isLogin;
    roleToggle.hidden = !isLogin;
    cardTitle.textContent = isLogin ? "Login" : "Create Account";
    hideStatus();
  }

  toAdminSignupLink.addEventListener("click", () => setAdminMode("signup"));
  toAdminLoginLink.addEventListener("click", () => setAdminMode("login"));

  // ------------------------------------------------------------------
  // CHUNK 3B — EMPLOYEE LOGIN <-> CREATE ACCOUNT ("Register here" / "Login here")
  // ------------------------------------------------------------------
  function setEmployeeMode(mode) {
    const isLogin = mode === "login";
    hideOtpStep();
    hideGoogleCompleteProfileStep();
    pendingOAuthSignup = null;
    pendingSignup = null;
    formEmployee.hidden = !isLogin;
    formSignup.hidden = isLogin;
    roleToggle.hidden = !isLogin;
    cardTitle.textContent = isLogin ? "Login" : "Create Account";
    hideStatus();
  }

  toSignupLink.addEventListener("click", () => setEmployeeMode("signup"));
  toLoginLink.addEventListener("click", () => setEmployeeMode("login"));

  // ------------------------------------------------------------------
  // CHUNK 3C — OTP VERIFICATION STEP (shared by both signup forms)
  // ------------------------------------------------------------------
  function showOtpStep(email) {
    formAdmin.hidden = true;
    formAdminSignup.hidden = true;
    formEmployee.hidden = true;
    formSignup.hidden = true;
    roleToggle.hidden = true;
    formOtpVerify.hidden = false;
    cardTitle.textContent = "Verify Your Email";
    document.getElementById("otp-sent-to").textContent = `We sent a 6-digit code to ${email}.`;
    clearOtpDigitInputs();
    hideStatus();
    document.querySelector('.otp-digit-input[data-index="0"]').focus();
  }

  function hideOtpStep() {
    formOtpVerify.hidden = true;
  }

  // ------------------------------------------------------------------
  // CHUNK 3E — GOOGLE COMPLETE-PROFILE STEP (first-time Google sign-in)
  // ------------------------------------------------------------------
  function showGoogleCompleteProfileStep() {
    formAdmin.hidden = true;
    formAdminSignup.hidden = true;
    formEmployee.hidden = true;
    formSignup.hidden = true;
    roleToggle.hidden = true;
    hideOtpStep();
    formGoogleComplete.hidden = false;
    cardTitle.textContent = "Complete Your Profile";
    document.getElementById("google-complete-intro").textContent =
      `Signed in with ${pendingOAuthSignup?.providerName || "your account"} — just a few more details to finish setting up your account.`;
    document.getElementById("google-complete-email").value = pendingOAuthSignup?.email || "";
    document.getElementById("google-complete-phone").value = "";
    document.getElementById("google-complete-staffcode").value = "";
    hideStatus();

    generateUniqueUsername(pendingOAuthSignup?.name || "", 0).then((suggested) => {
      document.getElementById("google-complete-username").value = suggested;
    });
  }

  function hideGoogleCompleteProfileStep() {
    formGoogleComplete.hidden = true;
  }

  // ------------------------------------------------------------------
  // CHUNK 3D — 6-DIGIT OTP BOXES (auto-advance, backspace, paste)
  // ------------------------------------------------------------------
  const otpDigitInputs = Array.from(document.querySelectorAll(".otp-digit-input"));

  function clearOtpDigitInputs() {
    otpDigitInputs.forEach((input) => { input.value = ""; });
  }

  function getOtpCode() {
    return otpDigitInputs.map((input) => input.value).join("");
  }

  otpDigitInputs.forEach((input, index) => {
    input.addEventListener("input", () => {
      // Only keep a single digit — strips anything non-numeric a user
      // might type or a stray extra character from autofill.
      input.value = input.value.replace(/\D/g, "").slice(0, 1);

      if (input.value && index < otpDigitInputs.length - 1) {
        otpDigitInputs[index + 1].focus();
      }
    });

    input.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && !input.value && index > 0) {
        otpDigitInputs[index - 1].focus();
      }
    });

    input.addEventListener("paste", (event) => {
      const pasted = (event.clipboardData || window.clipboardData).getData("text").replace(/\D/g, "");
      if (!pasted) return;
      event.preventDefault();

      otpDigitInputs.forEach((box, boxIndex) => {
        box.value = pasted[boxIndex] || "";
      });

      const lastFilledIndex = Math.min(pasted.length, otpDigitInputs.length) - 1;
      if (lastFilledIndex >= 0) otpDigitInputs[lastFilledIndex].focus();
    });
  });

  // ------------------------------------------------------------------
  // CHUNK 4 — PASSWORD VISIBILITY TOGGLE
  // (kept from the original Index.js, extended to work on both forms
  // via data-target instead of assuming a single password field)
  // ------------------------------------------------------------------
  const EYE_OPEN_INNER = '<path d="M2 12C4 7.5 7.8 5 12 5C16.2 5 20 7.5 22 12C20 16.5 16.2 19 12 19C7.8 19 4 16.5 2 12Z" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6"/>';
  const EYE_SLASH_INNER = EYE_OPEN_INNER + '<line x1="3.5" y1="20.5" x2="20.5" y2="3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>';

  document.querySelectorAll(".password-toggle").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const targetId = toggle.getAttribute("data-target");
      const input = document.getElementById(targetId);
      const willBeVisible = input.type === "password";
      input.type = willBeVisible ? "text" : "password";
      // Single icon, content swapped directly — visible password shows
      // the open eye, hidden password shows the slashed eye. No
      // separate elements to keep in sync with each other.
      toggle.querySelector(".toggle-icon").innerHTML = willBeVisible ? EYE_OPEN_INNER : EYE_SLASH_INNER;
    });
  });

  // ------------------------------------------------------------------
  // CHUNK 4B — FORGOT PASSWORD
  // ------------------------------------------------------------------
  document.querySelectorAll(".forgot-password-btn").forEach((btn) => {
    btn.addEventListener("click", () => promptForgotPassword());
  });

  // ------------------------------------------------------------------
  // CHUNK 5 — STATUS MESSAGE HELPERS
  // ------------------------------------------------------------------
  function showStatus(message, kind) {
    statusBox.textContent = message;
    statusBox.dataset.kind = kind;
    statusBox.hidden = false;
  }

  function hideStatus() {
    statusBox.hidden = true;
    statusBox.textContent = "";
  }

  // ------------------------------------------------------------------
  // CHUNK 5B — LIVE LOCKOUT COUNTDOWN
  // ----------------------------------------------------------------
  // Only one countdown runs at a time — starting a new one (e.g. the
  // other form's login attempt) clears any previous timer first.
  // ------------------------------------------------------------------
  let activeCountdownInterval = null;

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

  function formatSecondsLeft(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainderSeconds = seconds % 60;
    return `${minutes}m ${remainderSeconds}s`;
  }

  // ------------------------------------------------------------------
  // CHUNK 6 — BUTTON LOADING STATE
  // ------------------------------------------------------------------
  function setButtonLoading(button, isLoading, idleLabel, loadingLabel) {
    button.disabled = isLoading;
    const label = button.querySelector(".login-btn__label");
    if (label) label.textContent = isLoading ? loadingLabel : idleLabel;
  }

  // ------------------------------------------------------------------
  // CHUNK 6B — USERNAME AUTO-SUGGESTION (both signup forms)
  // ----------------------------------------------------------------
  // Auto-fills from the name once they leave that field (only if the
  // username field is still empty, so it never overwrites something
  // they've already typed/customized). "Regenerate" always overwrites
  // with the next available suggestion, since that's an explicit ask.
  // ------------------------------------------------------------------
  function wireUsernameAutoGen(nameInputId, usernameInputId, regenerateBtnId) {
    const nameInput = document.getElementById(nameInputId);
    const usernameInput = document.getElementById(usernameInputId);
    const regenerateBtn = document.getElementById(regenerateBtnId);
    let suffixCounter = 0;

    nameInput.addEventListener("blur", async () => {
      const name = nameInput.value.trim();
      if (!name || usernameInput.value.trim()) return;
      suffixCounter = 0;
      usernameInput.value = await generateUniqueUsername(name, suffixCounter);
    });

    regenerateBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.focus();
        return;
      }

      regenerateBtn.disabled = true;
      regenerateBtn.classList.add("is-spinning");
      suffixCounter += 1;

      try {
        usernameInput.value = await generateUniqueUsername(name, suffixCounter);
      } finally {
        regenerateBtn.disabled = false;
        setTimeout(() => regenerateBtn.classList.remove("is-spinning"), 350);
      }
    });
  }

  wireUsernameAutoGen("admin-signup-name", "admin-signup-username", "admin-username-regenerate");
  wireUsernameAutoGen("signup-name", "signup-username", "employee-username-regenerate");

  // ------------------------------------------------------------------
  // CHUNK 7 — ADMINISTRATOR LOGIN (Firebase Authentication)
  // ------------------------------------------------------------------
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
      const email = await resolveLoginEmail(ADMIN_COLLECTION, rawInput);
      if (!email) {
        const result = await recordFailedAttempt(rawInput);
        if (result.secondsLeft) {
          showLockoutCountdown(submitBtn, result.secondsLeft);
        } else {
          showStatus(result.message, "error");
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
      case "auth/email-already-in-use":
        return "An account already exists with that email.";
      case "auth/weak-password":
        return "Password must be at least 8 characters and include a mix of uppercase, lowercase, numbers, and symbols.";
      default:
        return "Something went wrong. Please try again.";
    }
  }

  // ------------------------------------------------------------------
  // CHUNK 7B — ADMINISTRATOR CREATE ACCOUNT (Firebase Authentication)
  // See the SECURITY NOTE at the top of this file (CHUNK 0).
  // ------------------------------------------------------------------
  async function handleAdminSignup(event) {
    event.preventDefault();
    hideStatus();

    const name = document.getElementById("admin-signup-name").value.trim();
    const username = document.getElementById("admin-signup-username").value.trim();
    const email = document.getElementById("admin-signup-email").value.trim();
    const phone = document.getElementById("admin-signup-phone").value.trim();
    const staffCode = document.getElementById("admin-signup-staffcode").value.trim();
    const password = document.getElementById("admin-signup-password").value;
    const confirmPassword = document.getElementById("admin-signup-confirm-password").value;
    const submitBtn = document.getElementById("admin-signup-submit");

    if (!name || !username || !email || !phone || !staffCode || !password || !confirmPassword) {
      showStatus("Fill in every field to create an account.", "error");
      return;
    }

    if (password !== confirmPassword) {
      showStatus("Passwords don't match.", "error");
      return;
    }

    const strength = validatePasswordStrength(password, name);
    if (!strength.valid) {
      showStatus(strength.message, "error");
      return;
    }

    setButtonLoading(submitBtn, true, "Create Account", "Verifying...");

    try {
      const staffCodeResult = await verifyStaffCode(staffCode);
      if (!staffCodeResult.valid) {
        showStatus(staffCodeResult.message, "error");
        return;
      }

      if (await isUsernameTaken(username)) {
        showStatus("That username is already taken. Try regenerating or pick another.", "error");
        return;
      }

      await sendOtpCode(email, name);
      pendingSignup = { role: "admin", name, username, email, phone, password };
      showOtpStep(email);
    } catch (error) {
      console.error("Couldn't start admin signup:", error);
      showStatus("Couldn't send a verification code right now. Please try again.", "error");
    } finally {
      setButtonLoading(submitBtn, false, "Create Account", "Verifying...");
    }
  }

  // ------------------------------------------------------------------
  // CHUNK 8 — EMPLOYEE LOGIN
  // ----------------------------------------------------------------
  // Employees sign in by username, but Firebase Auth needs an email.
  // So: look up the employee doc by username (public read, allowed by
  // your rules), pull its email field, then authenticate through
  // Firebase Auth with that email + the password they typed. The
  // password itself never touches Firestore — Auth verifies it.
  // ------------------------------------------------------------------
  async function handleEmployeeLogin(event) {
    event.preventDefault();
    hideStatus();

    const rawInput = document.getElementById("employee-username").value.trim();
    const password = document.getElementById("employee-password").value;
    const submitBtn = document.getElementById("employee-submit");

    if (!rawInput || !password) {
      showStatus("Enter both your email/username and password.", "error");
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
      const employeeDoc = await findEmployeeRecordByIdentifier(rawInput);

      if (!employeeDoc) {
        const result = await recordFailedAttempt(rawInput);
        if (result.secondsLeft) {
          showLockoutCountdown(submitBtn, result.secondsLeft);
        } else {
          showStatus(result.message, "error");
        }
        return;
      }

      const data = employeeDoc.data();

      if (data[EMPLOYEE_ACTIVE_FIELD] !== true) {
        showStatus("Your account isn't activated yet. Please verify your email first.", "error");
        return;
      }

      const suspendedUntilMillis = data.suspendedUntil?.toMillis?.();
      if (suspendedUntilMillis && suspendedUntilMillis > Date.now()) {
        showSuspensionOverlay(new Date(suspendedUntilMillis).toLocaleDateString(), data.suspensionReason || "");
        return;
      }

      const email = data[EMPLOYEE_EMAIL_FIELD];
      if (!email) {
        showStatus("This account has no email on file. Contact your administrator.", "error");
        return;
      }

      const rememberMe = document.getElementById("employee-remember-me").checked;
      await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);

      await signInWithEmailAndPassword(auth, email, password);
      await resetAttempts(rawInput);

      sessionStorage.setItem("almares_role", "employee");
      sessionStorage.setItem("almares_employee_doc_id", employeeDoc.id);

      showStatus("Signed in. Redirecting...", "success");
      window.location.replace(EMPLOYEE_REDIRECT_URL);
    } catch (error) {
      console.error(error);
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

  // ------------------------------------------------------------------
  // CHUNK 8B — EMAIL/USERNAME LOGIN HELPERS (shared by both roles)
  // ------------------------------------------------------------------
  function looksLikeEmail(value) {
    return value.includes("@");
  }

  // Admin: username → email resolution. If the input already looks
  // like an email, use it as-is — no lookup needed.
  async function resolveLoginEmail(collectionName, identifier) {
    if (looksLikeEmail(identifier)) return identifier;

    const ref = collection(db, collectionName);
    const byUsername = query(ref, where("username", "==", identifier), limit(1));
    const snapshot = await getDocs(byUsername);
    if (snapshot.empty) return null;
    return snapshot.docs[0].data().email || null;
  }

  async function findEmployeeRecord(usernameValue) {
    const employeesRef = collection(db, EMPLOYEE_COLLECTION);
    const byUsername = query(employeesRef, where(EMPLOYEE_USERNAME_FIELD, "==", usernameValue), limit(1));
    const snapshot = await getDocs(byUsername);
    return snapshot.empty ? null : snapshot.docs[0];
  }

  async function findEmployeeRecordByEmail(emailValue) {
    const employeesRef = collection(db, EMPLOYEE_COLLECTION);
    const byEmail = query(employeesRef, where(EMPLOYEE_EMAIL_FIELD, "==", emailValue), limit(1));
    const snapshot = await getDocs(byEmail);
    return snapshot.empty ? null : snapshot.docs[0];
  }

  // Employee: accepts either — checks which the input looks like and
  // looks up the matching record either way, so the activated-status
  // check downstream still works regardless of which path was used.
  async function findEmployeeRecordByIdentifier(identifier) {
    return looksLikeEmail(identifier)
      ? findEmployeeRecordByEmail(identifier)
      : findEmployeeRecord(identifier);
  }

  // ------------------------------------------------------------------
  // CHUNK 9 — EMPLOYEE CREATE ACCOUNT
  // ----------------------------------------------------------------
  // Creates a real Firebase Auth account first, then writes the
  // Firestore profile doc at employees/{uid} — the doc ID matching
  // the Auth UID is what your security rules require for the write
  // to be allowed (request.auth.uid == employeeId).
  // ------------------------------------------------------------------
  async function handleEmployeeSignup(event) {
    event.preventDefault();
    hideStatus();

    const name = document.getElementById("signup-name").value.trim();
    const username = document.getElementById("signup-username").value.trim();
    const email = document.getElementById("signup-email").value.trim();
    const phone = document.getElementById("signup-phone").value.trim();
    const staffCode = document.getElementById("signup-staffcode").value.trim();
    const password = document.getElementById("signup-password").value;
    const confirmPassword = document.getElementById("signup-confirm-password").value;
    const submitBtn = document.getElementById("signup-submit");

    if (!name || !username || !email || !phone || !staffCode || !password || !confirmPassword) {
      showStatus("Fill in every field to create an account.", "error");
      return;
    }

    if (password !== confirmPassword) {
      showStatus("Passwords don't match.", "error");
      return;
    }

    const strength = validatePasswordStrength(password, name);
    if (!strength.valid) {
      showStatus(strength.message, "error");
      return;
    }

    setButtonLoading(submitBtn, true, "Create Account", "Verifying...");

    try {
      const staffCodeResult = await verifyStaffCode(staffCode);
      if (!staffCodeResult.valid) {
        showStatus(staffCodeResult.message, "error");
        return;
      }

      if (await isUsernameTaken(username)) {
        showStatus("That username is already taken. Try regenerating or pick another.", "error");
        return;
      }

      await sendOtpCode(email, name);
      pendingSignup = { role: "employee", name, username, email, phone, password };
      showOtpStep(email);
    } catch (error) {
      console.error("Couldn't start employee signup:", error);
      showStatus("Couldn't send a verification code right now. Please try again.", "error");
    } finally {
      setButtonLoading(submitBtn, false, "Create Account", "Verifying...");
    }
  }

  // ------------------------------------------------------------------
  // CHUNK 9B — OTP VERIFICATION (stage 2 of signup)
  // ----------------------------------------------------------------
  // Nothing was written to Firebase Auth or Firestore in stage 1 —
  // this is where the account is actually created, only after the
  // code checks out.
  // ------------------------------------------------------------------
  async function handleOtpVerifySubmit(event) {
    event.preventDefault();
    hideStatus();

    if (!pendingSignup) {
      showStatus("Something went wrong — please start over.", "error");
      return;
    }

    const code = getOtpCode();
    const submitBtn = document.getElementById("otp-verify-submit");

    if (code.length < 6) {
      showStatus("Enter all 6 digits of the code.", "error");
      return;
    }

    setButtonLoading(submitBtn, true, "Verify & Create Account", "Verifying...");

    try {
      const result = await verifyOtpCode(pendingSignup.email, code);
      if (!result.valid) {
        showStatus(result.message, "error");
        return;
      }

      await completeSignup();
    } catch (error) {
      console.error("Couldn't complete signup:", error);
      showStatus(mapAuthError(error), "error");
    } finally {
      setButtonLoading(submitBtn, false, "Verify & Create Account", "Verifying...");
    }
  }

  async function completeSignup() {
    const { role, name, username, email, phone, password } = pendingSignup;

    const credential = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(credential.user, { displayName: name });

    if (role === "admin") {
      await setDoc(doc(db, ADMIN_COLLECTION, credential.user.uid), {
        name,
        email,
        phone,
        username,
        role: "admin",
        createdAt: serverTimestamp()
      });
    } else {
      await setDoc(doc(db, EMPLOYEE_COLLECTION, credential.user.uid), {
        [EMPLOYEE_NAME_FIELD]: name,
        [EMPLOYEE_USERNAME_FIELD]: username,
        [EMPLOYEE_EMAIL_FIELD]: email,
        phone,
        // Web signup's OTP step IS the activation — no separate
        // mobile-app activation needed for accounts created here.
        [EMPLOYEE_ACTIVE_FIELD]: true,
        role: "employee",
        createdAt: serverTimestamp()
      });
    }

    // Sign back out — createUserWithEmailAndPassword auto-authenticates,
    // so without this the person would stay secretly signed in while
    // looking at the login form.
    await signOut(auth);
    sessionStorage.removeItem("almares_role");

    const wasAdmin = role === "admin";
    pendingSignup = null;
    hideOtpStep();

    showStatus(`Account created! Your username is "${username}" — please log in.`, "success");
    if (wasAdmin) {
      formAdminSignup.reset();
      setAdminMode("login");
    } else {
      formSignup.reset();
      setEmployeeMode("login");
    }
  }

  async function handleOtpResend() {
    if (!pendingSignup) return;
    const resendBtn = document.getElementById("otp-resend-btn");
    resendBtn.disabled = true;

    try {
      await sendOtpCode(pendingSignup.email, pendingSignup.name);
      clearOtpDigitInputs();
      otpDigitInputs[0].focus();
      showStatus("A new code has been sent.", "success");
    } catch (error) {
      console.error("Couldn't resend code:", error);
      showStatus("Couldn't resend the code right now. Please try again.", "error");
    } finally {
      resendBtn.disabled = false;
    }
  }

  // Abandons the in-progress signup entirely — nothing was ever
  // written to Firebase Auth or Firestore for it in the first place,
  // so there's nothing to undo, just clear the pending state and
  // return to that role's login screen.
  function handleOtpCancel() {
    const wasAdmin = pendingSignup?.role === "admin";
    pendingSignup = null;
    clearOtpDigitInputs();

    if (wasAdmin) {
      setAdminMode("login");
    } else {
      setEmployeeMode("login");
    }
  }

  // ------------------------------------------------------------------
  // CHUNK 9C — GOOGLE SIGN-IN
  // ----------------------------------------------------------------
  // Google already verifies email ownership, so a new Google sign-up
  // skips the OTP step entirely (there's nothing left to prove) — but
  // it still has to pass the Staff Code gate, same as any other new
  // account, so Google alone can't be used to sidestep that.
  // Existing accounts (already have a Firestore doc) just sign
  // straight in, no extra steps.
  // ------------------------------------------------------------------
  async function handleOAuthSignIn(role, provider, providerName, btnId) {
    const btn = document.getElementById(btnId);
    btn.disabled = true;
    hideStatus();

    try {
      const collectionName = role === "admin" ? ADMIN_COLLECTION : EMPLOYEE_COLLECTION;
      const result = await signInWithPopup(auth, provider);
      const user = result.user;

      const existingDoc = await getDoc(doc(db, collectionName, user.uid));

      if (existingDoc.exists()) {
        const data = existingDoc.data();

        if (role === "employee" && data[EMPLOYEE_ACTIVE_FIELD] !== true) {
          await signOut(auth);
          showStatus("Your account isn't activated yet. Please verify your email first.", "error");
          return;
        }

        sessionStorage.setItem("almares_role", role);
        if (role === "employee") sessionStorage.setItem("almares_employee_doc_id", user.uid);

        showStatus("Signed in. Redirecting...", "success");
        window.location.replace(role === "admin" ? ADMIN_REDIRECT_URL : EMPLOYEE_REDIRECT_URL);
        return;
      }

      // First time signing in with this account for this role — no
      // Firestore profile yet. They stay authenticated (the popup
      // already did that part) but get no app access until they
      // finish this step and a real profile doc gets created.
      pendingOAuthSignup = {
        role,
        uid: user.uid,
        name: user.displayName || "",
        // Google always provides an email — this fallback just guards
        // against an unexpected missing value from the provider.
        email: user.email || "",
        providerName
      };
      showGoogleCompleteProfileStep();
    } catch (error) {
      if (error.code === "auth/popup-closed-by-user" || error.code === "auth/cancelled-popup-request") {
        // They just closed the popup — not a real error, nothing to show.
      } else {
        console.error(`${providerName} sign-in failed:`, error);
        showStatus(`${providerName} sign-in failed. Please try again.`, "error");
      }
    } finally {
      btn.disabled = false;
    }
  }

  async function handleGoogleCompleteProfileSubmit(event) {
    event.preventDefault();
    hideStatus();

    if (!pendingOAuthSignup) {
      showStatus("Something went wrong — please start over.", "error");
      return;
    }

    const email = document.getElementById("google-complete-email").value.trim();
    const username = document.getElementById("google-complete-username").value.trim();
    const phone = document.getElementById("google-complete-phone").value.trim();
    const staffCode = document.getElementById("google-complete-staffcode").value.trim();
    const submitBtn = document.getElementById("google-complete-submit");

    if (!email || !username || !phone || !staffCode) {
      showStatus("Fill in every field to finish setting up your account.", "error");
      return;
    }

    setButtonLoading(submitBtn, true, "Finish Setting Up", "Verifying...");

    try {
      const staffCodeResult = await verifyStaffCode(staffCode);
      if (!staffCodeResult.valid) {
        showStatus(staffCodeResult.message, "error");
        return;
      }

      if (await isUsernameTaken(username)) {
        showStatus("That username is already taken. Try regenerating or pick another.", "error");
        return;
      }

      const { role, uid, name } = pendingOAuthSignup;

      if (role === "admin") {
        await setDoc(doc(db, ADMIN_COLLECTION, uid), {
          name,
          email,
          phone,
          username,
          role: "admin",
          createdAt: serverTimestamp()
        });
      } else {
        await setDoc(doc(db, EMPLOYEE_COLLECTION, uid), {
          [EMPLOYEE_NAME_FIELD]: name,
          [EMPLOYEE_USERNAME_FIELD]: username,
          [EMPLOYEE_EMAIL_FIELD]: email,
          phone,
          // Google already verified this email — same trust level our
          // own OTP step provides, so this counts as activated too.
          [EMPLOYEE_ACTIVE_FIELD]: true,
          role: "employee",
          createdAt: serverTimestamp()
        });
      }

      sessionStorage.setItem("almares_role", role);
      if (role === "employee") sessionStorage.setItem("almares_employee_doc_id", uid);

      pendingOAuthSignup = null;
      showStatus("Account created! Redirecting...", "success");
      window.location.replace(role === "admin" ? ADMIN_REDIRECT_URL : EMPLOYEE_REDIRECT_URL);
    } catch (error) {
      console.error("Couldn't complete Google signup:", error);
      showStatus("Something went wrong. Please try again.", "error");
    } finally {
      setButtonLoading(submitBtn, false, "Finish Setting Up", "Verifying...");
    }
  }

  // Abandoning this step leaves a signed-in Firebase Auth user with no
  // Firestore profile — sign them back out so they're not left in that
  // half-finished state.
  async function handleGoogleCompleteCancel() {
    const wasAdmin = pendingOAuthSignup?.role === "admin";
    pendingOAuthSignup = null;

    try {
      await signOut(auth);
    } catch (error) {
      console.error("Couldn't sign out:", error);
    }

    if (wasAdmin) {
      setAdminMode("login");
    } else {
      setEmployeeMode("login");
    }
  }

  let googleCompleteUsernameSuffix = 0;
  async function handleGoogleUsernameRegenerate() {
    const btn = document.getElementById("google-username-regenerate");
    btn.disabled = true;
    btn.classList.add("is-spinning");
    googleCompleteUsernameSuffix += 1;

    try {
      const suggested = await generateUniqueUsername(pendingOAuthSignup?.name || "", googleCompleteUsernameSuffix);
      document.getElementById("google-complete-username").value = suggested;
    } finally {
      btn.disabled = false;
      setTimeout(() => btn.classList.remove("is-spinning"), 350);
    }
  }

  // ------------------------------------------------------------------
  // CHUNK 10 — DISCOURAGE LOGO DOWNLOADS
  // ----------------------------------------------------------------
  // Blocks the right-click "Save image as" menu and drag-to-save on
  // any element tagged .no-download. This is a deterrent for casual
  // users, not real protection — devtools/view-source can still get
  // the file. For real protection, don't serve the raw asset publicly.
  // ------------------------------------------------------------------
  document.querySelectorAll(".no-download").forEach((el) => {
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("dragstart", (e) => e.preventDefault());
  });

  // ------------------------------------------------------------------
  // CHUNK 11 — WIRE UP FORM SUBMISSIONS
  // ------------------------------------------------------------------
  formAdmin.addEventListener("submit", handleAdminLogin);
  formAdminSignup.addEventListener("submit", handleAdminSignup);
  formEmployee.addEventListener("submit", handleEmployeeLogin);
  formSignup.addEventListener("submit", handleEmployeeSignup);
  formOtpVerify.addEventListener("submit", handleOtpVerifySubmit);
  document.getElementById("otp-resend-btn").addEventListener("click", handleOtpResend);
  document.getElementById("otp-cancel-btn").addEventListener("click", handleOtpCancel);

  document.getElementById("admin-google-btn").addEventListener("click", () =>
    handleOAuthSignIn("admin", googleProvider, "Google", "admin-google-btn")
  );
  document.getElementById("employee-google-btn").addEventListener("click", () =>
    handleOAuthSignIn("employee", googleProvider, "Google", "employee-google-btn")
  );
  formGoogleComplete.addEventListener("submit", handleGoogleCompleteProfileSubmit);
  document.getElementById("google-username-regenerate").addEventListener("click", handleGoogleUsernameRegenerate);
  document.getElementById("google-complete-cancel-btn").addEventListener("click", handleGoogleCompleteCancel);

  // If Sidebar.js just signed someone out mid-session because their
  // account got suspended while they were actively using the app,
  // show them why instead of silently dropping them on a blank form.
  const urlParams = new URLSearchParams(window.location.search);
  const suspendedUntil = urlParams.get("suspended");
  if (suspendedUntil) {
    showSuspensionOverlay(suspendedUntil, urlParams.get("reason") || "");
  }
});

// ------------------------------------------------------------------
// GLASS-EFFECT SUSPENSION OVERLAY
// ----------------------------------------------------------------
// Deliberately a prominent full modal, not the usual thin inline
// status bar — this is important enough to be impossible to miss,
// whether it's shown right after a blocked login attempt or right
// after being signed out mid-session by a live suspension.
// ------------------------------------------------------------------
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

  // Clean the query params out of the URL so refreshing the page
  // doesn't show this same overlay again.
  if (window.history.replaceState) {
    window.history.replaceState({}, "", window.location.pathname);
  }
}

function escapeHtmlSuspension(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
