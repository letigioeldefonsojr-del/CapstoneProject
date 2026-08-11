import { auth, db } from "./firebase-config.js";
import { sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// ====================================================================
// FORGOT PASSWORD — search first, then reset
// ----------------------------------------------------------------
// Step 1: search by username, phone number, or (partial) name — both
// admins and employees collections are checked. Step 2: shows
// matching accounts with the email masked (e.g. "jo***@gm***.com")
// so the real owner can recognize their own account without fully
// exposing it to anyone just guessing. Clicking an account sends the
// actual reset email to its real (unmasked) address.
//
// Honest privacy note: letting people search accounts by name has a
// real tradeoff — it lets someone probe for who has an account here,
// even with masking. That's a deliberate choice matching what was
// asked for; worth knowing it's not zero-risk.
//
// Reset link still uses the same custom ResetPassword.html page (see
// ActionCodeSettings below) — same as before, still requires this
// domain listed under Authentication → Settings → Authorized domains.
// ====================================================================
const RESET_PASSWORD_URL = "https://capstoneproject-403.pages.dev/ResetPassword.html";
const actionCodeSettings = {
  url: RESET_PASSWORD_URL,
  handleCodeInApp: true
};

export function promptForgotPassword() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal__header">
        <h3>Find your account</h3>
        <button type="button" class="modal__close" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      <div class="modal__body">
        <p class="confirm-dialog__message" id="fp-intro">Enter your username, phone number, or name to find your account.</p>

        <div class="form-field" id="fp-search-field" style="margin-top: 14px;">
          <label for="fp-search-input">Username, phone number, or name</label>
          <input type="text" id="fp-search-input" autocomplete="off">
        </div>

        <div id="fp-results-list" style="margin-top: 14px;"></div>

        <p class="form-status" id="fp-status" hidden></p>
      </div>
      <div class="modal__footer">
        <button type="button" class="btn-outline" data-action="cancel">Cancel</button>
        <button type="button" class="btn-primary" data-action="search">Search</button>
      </div>
    </div>
  `;

  const searchInput = overlay.querySelector("#fp-search-input");
  const resultsList = overlay.querySelector("#fp-results-list");
  const statusEl = overlay.querySelector("#fp-status");
  const introEl = overlay.querySelector("#fp-intro");
  const searchField = overlay.querySelector("#fp-search-field");
  const footerBtn = overlay.querySelector('[data-action="search"]');

  function close() {
    overlay.remove();
  }

  function showStatus(message, kind) {
    statusEl.textContent = message;
    statusEl.dataset.kind = kind;
    statusEl.hidden = false;
  }

  function hideStatus() {
    statusEl.hidden = true;
  }

  overlay.querySelector(".modal__close").addEventListener("click", close);
  overlay.querySelector('[data-action="cancel"]').addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });

  async function handleSearch() {
    const term = searchInput.value.trim();
    hideStatus();
    resultsList.innerHTML = "";

    if (!term) {
      showStatus("Enter a username, phone number, or name to search.", "error");
      return;
    }

    footerBtn.disabled = true;
    footerBtn.textContent = "Searching...";

    try {
      const results = await searchAccounts(term);

      if (results.length === 0) {
        showStatus("No matching account found. Check your spelling and try again.", "error");
        return;
      }

      renderResults(results);
    } catch (error) {
      console.error("Couldn't search accounts:", error);
      showStatus("Something went wrong searching. Please try again.", "error");
    } finally {
      footerBtn.disabled = false;
      footerBtn.textContent = "Search";
    }
  }

  function renderResults(results) {
    introEl.textContent = `Found ${results.length} matching account${results.length === 1 ? "" : "s"}. Click yours to send a reset link.`;

    results.forEach((account) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "fp-account-result";
      item.innerHTML = `
        <span class="fp-account-result__role"></span>
        <span class="fp-account-result__info">
          <strong class="fp-account-result__name"></strong>
          <span class="fp-account-result__email"></span>
        </span>
      `;
      item.querySelector(".fp-account-result__role").textContent = account.role === "admin" ? "Admin" : "Employee";
      item.querySelector(".fp-account-result__name").textContent = account.name || "(no name on file)";
      item.querySelector(".fp-account-result__email").textContent = account.email ? maskEmail(account.email) : "No email on file";

      item.addEventListener("click", () => handleAccountSelected(account));
      resultsList.appendChild(item);
    });
  }

  async function handleAccountSelected(account) {
    hideStatus();

    if (!account.email) {
      showStatus("This account has no email on file. Contact an administrator.", "error");
      return;
    }

    resultsList.innerHTML = "";
    searchField.hidden = true;
    footerBtn.hidden = true;
    introEl.textContent = `Sending a reset link to ${maskEmail(account.email)}...`;

    try {
      await sendPasswordResetEmail(auth, account.email, actionCodeSettings);
      introEl.textContent = "Reset link sent!";
      showStatus(`Check the inbox for ${maskEmail(account.email)} — click the link there to set a new password.`, "success");
    } catch (error) {
      console.error("Couldn't send reset email:", error);
      showStatus("Something went wrong sending the reset link. Please try again.", "error");
      searchField.hidden = false;
      footerBtn.hidden = false;
    }
  }

  footerBtn.addEventListener("click", handleSearch);
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleSearch();
    }
  });

  document.body.appendChild(overlay);
  searchInput.focus();
}

// ---- Account search (client-side filter — both collections are
// small enough that fetching all docs and filtering here is simpler
// and more flexible than Firestore's limited query capabilities,
// especially for a "name contains" search, which Firestore can't do
// natively at all) -----------------------------------------------
async function searchAccounts(term) {
  const normalizedTerm = term.trim().toLowerCase();
  const normalizedPhone = term.replace(/\D/g, "");

  const [adminsSnap, employeesSnap] = await Promise.all([
    getDocs(collection(db, "admins")),
    getDocs(collection(db, "employees"))
  ]);

  const results = [];

  adminsSnap.forEach((docSnap) => {
    const data = docSnap.data();
    if (matchesSearch(data, data.name, normalizedTerm, normalizedPhone)) {
      results.push({
        id: docSnap.id,
        role: "admin",
        name: data.name,
        email: data.email
      });
    }
  });

  employeesSnap.forEach((docSnap) => {
    const data = docSnap.data();
    if (matchesSearch(data, data.firstName, normalizedTerm, normalizedPhone)) {
      results.push({
        id: docSnap.id,
        role: "employee",
        name: data.firstName,
        email: data.email
      });
    }
  });

  return results;
}

function matchesSearch(data, nameValue, normalizedTerm, normalizedPhone) {
  const username = (data.username || "").toLowerCase();
  const phone = (data.phone || "").replace(/\D/g, "");
  const name = (nameValue || "").toLowerCase();

  if (username && username === normalizedTerm) return true;
  if (normalizedPhone && phone && phone === normalizedPhone) return true;
  if (name && normalizedTerm && name.includes(normalizedTerm)) return true;
  return false;
}

function maskEmail(email) {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) return email;

  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex + 1);

  const maskedLocal = local.length <= 2
    ? local[0] + "*"
    : local.slice(0, 2) + "*".repeat(Math.max(local.length - 2, 1));

  const dotIndex = domain.indexOf(".");
  const domainName = dotIndex === -1 ? domain : domain.slice(0, dotIndex);
  const domainRest = dotIndex === -1 ? "" : domain.slice(dotIndex);
  const maskedDomainName = domainName.length <= 2
    ? domainName[0] + "*"
    : domainName.slice(0, 2) + "*".repeat(Math.max(domainName.length - 2, 1));

  return `${maskedLocal}@${maskedDomainName}${domainRest}`;
}
