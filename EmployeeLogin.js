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

const EMPLOYEE_COLLECTION     = "employees";
const EMPLOYEE_NAME_FIELD     = "firstName";
const EMPLOYEE_USERNAME_FIELD = "username";
const EMPLOYEE_EMAIL_FIELD    = "email";
const EMPLOYEE_ACTIVE_FIELD   = "activated";
const EMPLOYEE_REDIRECT_URL   = "Dashboard.html";
const LOGIN_PAGE_URL = "EmployeeLogin.html";

// If already signed in (and genuinely a valid, activated employee),
// skip straight past the login form instead of making them log in
// again.
onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  try {
    const snap = await getDoc(doc(db, EMPLOYEE_COLLECTION, user.uid));
    if (snap.exists() && snap.data()[EMPLOYEE_ACTIVE_FIELD] === true) {
      sessionStorage.setItem("almares_employee_doc_id", user.uid);
      window.location.replace(EMPLOYEE_REDIRECT_URL);
    }
  } catch (error) {
    console.error("Couldn't check existing session:", error);
  }
});

document.addEventListener("DOMContentLoaded", () => {

  const SIGNUP_PASSWORD_FIELD_IDS = ["signup-password", "signup-confirm-password"];
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

  const cardTitle    = document.getElementById("card-title");
  const formEmployee = document.getElementById("form-employee");
  const formSignup   = document.getElementById("form-employee-signup");
  const formOtpVerify = document.getElementById("form-otp-verify");
  const formGoogleComplete = document.getElementById("form-google-complete-profile");
  const toSignupLink = document.getElementById("to-signup");
  const toLoginLink  = document.getElementById("to-login");
  const statusBox = document.getElementById("form-status");
  const googleProvider = new GoogleAuthProvider();

  let pendingSignup = null;
  let pendingOAuthSignup = null;
  let activeCountdownInterval = null;

  function setEmployeeMode(mode) {
    const isLogin = mode === "login";
    hideOtpStep();
    hideGoogleCompleteProfileStep();
    pendingOAuthSignup = null;
    pendingSignup = null;
    formEmployee.hidden = !isLogin;
    formSignup.hidden = isLogin;
    cardTitle.textContent = isLogin ? "Employee Login" : "Create Account";
    hideStatus();
  }

  toSignupLink.addEventListener("click", () => setEmployeeMode("signup"));
  toLoginLink.addEventListener("click", () => setEmployeeMode("login"));

  function showOtpStep(email) {
    formEmployee.hidden = true;
    formSignup.hidden = true;
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

  function showGoogleCompleteProfileStep() {
    formEmployee.hidden = true;
    formSignup.hidden = true;
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

  const otpDigitInputs = Array.from(document.querySelectorAll(".otp-digit-input"));

  function clearOtpDigitInputs() {
    otpDigitInputs.forEach((input) => { input.value = ""; });
  }

  function getOtpCode() {
    return otpDigitInputs.map((input) => input.value).join("");
  }

  otpDigitInputs.forEach((input, index) => {
    input.addEventListener("input", () => {
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
      otpDigitInputs.forEach((box, boxIndex) => { box.value = pasted[boxIndex] || ""; });
      const lastFilledIndex = Math.min(pasted.length, otpDigitInputs.length) - 1;
      if (lastFilledIndex >= 0) otpDigitInputs[lastFilledIndex].focus();
    });
  });

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

  function showStatus(message, kind) {
    statusBox.textContent = message;
    statusBox.dataset.kind = kind;
    statusBox.hidden = false;
  }

  function hideStatus() {
    statusBox.hidden = true;
    statusBox.textContent = "";
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

  function formatSecondsLeft(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainderSeconds = seconds % 60;
    return `${minutes}m ${remainderSeconds}s`;
  }

  function setButtonLoading(button, isLoading, idleLabel, loadingLabel) {
    button.disabled = isLoading;
    const label = button.querySelector(".login-btn__label");
    if (label) label.textContent = isLoading ? loadingLabel : idleLabel;
  }

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

  wireUsernameAutoGen("signup-name", "signup-username", "employee-username-regenerate");

  function looksLikeEmail(value) {
    return value.includes("@");
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

  async function findEmployeeRecordByIdentifier(identifier) {
    return looksLikeEmail(identifier)
      ? findEmployeeRecordByEmail(identifier)
      : findEmployeeRecord(identifier);
  }

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

  async function handleEmployeeSignup(event) {
    event.preventDefault();
    hideStatus();

    const name = document.getElementById("signup-name").value.trim();
    const username = document.getElementById("signup-username").value.trim();
    const email = document.getElementById("signup-email").value.trim();
    const phoneDigits = document.getElementById("signup-phone").value.trim();
    const phone = phoneDigits ? `+63${phoneDigits}` : "";
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
    const { name, username, email, phone, password } = pendingSignup;

    const credential = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(credential.user, { displayName: name });

    await setDoc(doc(db, EMPLOYEE_COLLECTION, credential.user.uid), {
      [EMPLOYEE_NAME_FIELD]: name,
      [EMPLOYEE_USERNAME_FIELD]: username,
      [EMPLOYEE_EMAIL_FIELD]: email,
      phone,
      [EMPLOYEE_ACTIVE_FIELD]: true,
      role: "employee",
      createdAt: serverTimestamp()
    });

    await signOut(auth);
    sessionStorage.removeItem("almares_role");

    pendingSignup = null;
    hideOtpStep();

    showStatus(`Account created! Your username is "${username}" — please log in.`, "success");
    formSignup.reset();
    setEmployeeMode("login");
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

  function handleOtpCancel() {
    pendingSignup = null;
    clearOtpDigitInputs();
    setEmployeeMode("login");
  }

  async function handleOAuthSignIn(role, provider, providerName, btnId) {
    const btn = document.getElementById(btnId);
    btn.disabled = true;
    hideStatus();

    try {
      const result = await signInWithPopup(auth, provider);
      const user = result.user;
      const existingDoc = await getDoc(doc(db, EMPLOYEE_COLLECTION, user.uid));

      if (existingDoc.exists()) {
        const data = existingDoc.data();

        if (data[EMPLOYEE_ACTIVE_FIELD] !== true) {
          await signOut(auth);
          showStatus("Your account isn't activated yet. Please verify your email first.", "error");
          return;
        }

        const suspendedUntilMillis = data.suspendedUntil?.toMillis?.();
        if (suspendedUntilMillis && suspendedUntilMillis > Date.now()) {
          await signOut(auth);
          showSuspensionOverlay(new Date(suspendedUntilMillis).toLocaleDateString(), data.suspensionReason || "");
          return;
        }

        sessionStorage.setItem("almares_role", "employee");
        sessionStorage.setItem("almares_employee_doc_id", user.uid);

        showStatus("Signed in. Redirecting...", "success");
        window.location.replace(EMPLOYEE_REDIRECT_URL);
        return;
      }

      pendingOAuthSignup = {
        role,
        uid: user.uid,
        name: user.displayName || "",
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
    const phoneDigits = document.getElementById("google-complete-phone").value.trim();
    const phone = phoneDigits ? `+63${phoneDigits}` : "";
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

      const { uid, name } = pendingOAuthSignup;

      await setDoc(doc(db, EMPLOYEE_COLLECTION, uid), {
        [EMPLOYEE_NAME_FIELD]: name,
        [EMPLOYEE_USERNAME_FIELD]: username,
        [EMPLOYEE_EMAIL_FIELD]: email,
        phone,
        [EMPLOYEE_ACTIVE_FIELD]: true,
        role: "employee",
        createdAt: serverTimestamp()
      });

      sessionStorage.setItem("almares_role", "employee");
      sessionStorage.setItem("almares_employee_doc_id", uid);

      pendingOAuthSignup = null;
      showStatus("Account created! Redirecting...", "success");
      window.location.replace(EMPLOYEE_REDIRECT_URL);
    } catch (error) {
      console.error("Couldn't complete Google signup:", error);
      showStatus("Something went wrong. Please try again.", "error");
    } finally {
      setButtonLoading(submitBtn, false, "Finish Setting Up", "Verifying...");
    }
  }

  async function handleGoogleCompleteCancel() {
    pendingOAuthSignup = null;
    try {
      await signOut(auth);
    } catch (error) {
      console.error("Couldn't sign out:", error);
    }
    setEmployeeMode("login");
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

  formEmployee.addEventListener("submit", handleEmployeeLogin);
  formSignup.addEventListener("submit", handleEmployeeSignup);
  formOtpVerify.addEventListener("submit", handleOtpVerifySubmit);
  document.getElementById("otp-resend-btn").addEventListener("click", handleOtpResend);
  document.getElementById("otp-cancel-btn").addEventListener("click", handleOtpCancel);
  document.getElementById("employee-google-btn").addEventListener("click", () =>
    handleOAuthSignIn("employee", googleProvider, "Google", "employee-google-btn")
  );
  formGoogleComplete.addEventListener("submit", handleGoogleCompleteProfileSubmit);
  document.getElementById("google-username-regenerate").addEventListener("click", handleGoogleUsernameRegenerate);
  document.getElementById("google-complete-cancel-btn").addEventListener("click", handleGoogleCompleteCancel);
  document.querySelectorAll(".forgot-password-btn").forEach((btn) => {
    btn.addEventListener("click", () => promptForgotPassword());
  });

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
