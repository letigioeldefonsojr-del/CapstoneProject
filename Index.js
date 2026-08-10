import { auth, db } from "./firebase-config.js";
import { promptForgotPassword } from "./ForgotPassword.js";
import { validatePasswordStrength } from "./PasswordStrength.js";
import { checkLoginAllowed, recordFailedAttempt, resetAttempts } from "./LoginAttempts.js";
import { verifyStaffCode } from "./StaffCode.js";
import { sendOtpCode, verifyOtpCode } from "./OtpVerification.js";
import { generateUniqueUsername } from "./UsernameGenerator.js";
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  collection, query, where, getDocs, limit, serverTimestamp, doc, setDoc
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

  // Holds the not-yet-created account's data between "passed initial
  // validation, OTP sent" and "OTP verified, actually create the
  // account" — nothing is written to Firebase Auth or Firestore until
  // the code is confirmed.
  let pendingSignup = null;

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
    document.getElementById("otp-code-input").value = "";
    hideStatus();
    document.getElementById("otp-code-input").focus();
  }

  function hideOtpStep() {
    formOtpVerify.hidden = true;
  }

  // ------------------------------------------------------------------
  // CHUNK 4 — PASSWORD VISIBILITY TOGGLE
  // (kept from the original Index.js, extended to work on both forms
  // via data-target instead of assuming a single password field)
  // ------------------------------------------------------------------
  document.querySelectorAll(".password-toggle").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const targetId = toggle.getAttribute("data-target");
      const input = document.getElementById(targetId);
      const isPass = input.type === "password";
      input.type = isPass ? "text" : "password";
      toggle.querySelector(".icon-eye").hidden = isPass;
      toggle.querySelector(".icon-eye-slash").hidden = !isPass;
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
  // CHUNK 6 — BUTTON LOADING STATE
  // ------------------------------------------------------------------
  function setButtonLoading(button, isLoading, idleLabel, loadingLabel) {
    button.disabled = isLoading;
    const label = button.querySelector(".login-btn__label");
    if (label) label.textContent = isLoading ? loadingLabel : idleLabel;
  }

  // ------------------------------------------------------------------
  // CHUNK 7 — ADMINISTRATOR LOGIN (Firebase Authentication)
  // ------------------------------------------------------------------
  async function handleAdminLogin(event) {
    event.preventDefault();
    hideStatus();

    const email = document.getElementById("admin-email").value.trim();
    const password = document.getElementById("admin-password").value;
    const submitBtn = document.getElementById("admin-submit");

    if (!email || !password) {
      showStatus("Enter both email and password.", "error");
      return;
    }

    const lockStatus = await checkLoginAllowed(email);
    if (!lockStatus.allowed) {
      showStatus(lockStatus.message, "error");
      return;
    }

    setButtonLoading(submitBtn, true, "Login", "Signing in...");

    try {
      await signInWithEmailAndPassword(auth, email, password);
      await resetAttempts(email);
      sessionStorage.setItem("almares_role", "admin");
      showStatus("Signed in. Redirecting...", "success");
      window.location.replace(ADMIN_REDIRECT_URL);
    } catch (error) {
      if (isWrongCredentialError(error)) {
        const message = await recordFailedAttempt(email);
        showStatus(message, "error");
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
    const email = document.getElementById("admin-signup-email").value.trim();
    const phone = document.getElementById("admin-signup-phone").value.trim();
    const staffCode = document.getElementById("admin-signup-staffcode").value.trim();
    const password = document.getElementById("admin-signup-password").value;
    const confirmPassword = document.getElementById("admin-signup-confirm-password").value;
    const submitBtn = document.getElementById("admin-signup-submit");

    if (!name || !email || !phone || !staffCode || !password || !confirmPassword) {
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

      await sendOtpCode(email, name);
      pendingSignup = { role: "admin", name, email, phone, password };
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

    const usernameInput = document.getElementById("employee-username").value.trim();
    const password = document.getElementById("employee-password").value;
    const submitBtn = document.getElementById("employee-submit");

    if (!usernameInput || !password) {
      showStatus("Enter both your username and password.", "error");
      return;
    }

    const lockStatus = await checkLoginAllowed(usernameInput);
    if (!lockStatus.allowed) {
      showStatus(lockStatus.message, "error");
      return;
    }

    setButtonLoading(submitBtn, true, "Login", "Signing in...");

    try {
      const employeeDoc = await findEmployeeRecord(usernameInput);

      if (!employeeDoc) {
        const message = await recordFailedAttempt(usernameInput);
        showStatus(message, "error");
        return;
      }

      const data = employeeDoc.data();

      if (data[EMPLOYEE_ACTIVE_FIELD] !== true) {
        showStatus("Your account isn't activated yet. Please verify your email first.", "error");
        return;
      }

      const email = data[EMPLOYEE_EMAIL_FIELD];
      if (!email) {
        showStatus("This account has no email on file. Contact your administrator.", "error");
        return;
      }

      await signInWithEmailAndPassword(auth, email, password);
      await resetAttempts(usernameInput);

      sessionStorage.setItem("almares_role", "employee");
      sessionStorage.setItem("almares_employee_doc_id", employeeDoc.id);

      showStatus("Signed in. Redirecting...", "success");
      window.location.replace(EMPLOYEE_REDIRECT_URL);
    } catch (error) {
      console.error(error);
      if (isWrongCredentialError(error)) {
        const message = await recordFailedAttempt(usernameInput);
        showStatus(message, "error");
      } else {
        showStatus(mapAuthError(error), "error");
      }
    } finally {
      setButtonLoading(submitBtn, false, "Login", "Signing in...");
    }
  }

  async function findEmployeeRecord(usernameValue) {
    const employeesRef = collection(db, EMPLOYEE_COLLECTION);
    const byUsername = query(employeesRef, where(EMPLOYEE_USERNAME_FIELD, "==", usernameValue), limit(1));
    const snapshot = await getDocs(byUsername);
    return snapshot.empty ? null : snapshot.docs[0];
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
    const email = document.getElementById("signup-email").value.trim();
    const phone = document.getElementById("signup-phone").value.trim();
    const staffCode = document.getElementById("signup-staffcode").value.trim();
    const password = document.getElementById("signup-password").value;
    const confirmPassword = document.getElementById("signup-confirm-password").value;
    const submitBtn = document.getElementById("signup-submit");

    if (!name || !email || !phone || !staffCode || !password || !confirmPassword) {
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

      await sendOtpCode(email, name);
      pendingSignup = { role: "employee", name, email, phone, password };
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

    const code = document.getElementById("otp-code-input").value.trim();
    const submitBtn = document.getElementById("otp-verify-submit");

    if (!code) {
      showStatus("Enter the 6-digit code.", "error");
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
    const { role, name, email, phone, password } = pendingSignup;
    const username = await generateUniqueUsername(name);

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
      showStatus("A new code has been sent.", "success");
    } catch (error) {
      console.error("Couldn't resend code:", error);
      showStatus("Couldn't resend the code right now. Please try again.", "error");
    } finally {
      resendBtn.disabled = false;
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
});