import { guardCall } from "./LoginGuard.js?v=20261030d";

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
// Everything sensitive now happens on the server (the login-guard
// function): it searches the accounts, shows only a MASKED email to the
// browser, looks up the real address itself and asks Firebase to send
// the reset link (to the same custom ResetPassword.html page as before,
// which still needs this domain under Authentication → Settings →
// Authorized domains). The 5-per-hour limit per address is enforced there too.
// ====================================================================

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
        <p class="confirm-dialog__message" id="fp-intro">Enter your email, username, phone number, or name to find your account.</p>

        <div class="form-field" id="fp-search-field" style="margin-top: 14px;">
          <label for="fp-search-input">Email, username, phone number, or name</label>
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
      showStatus("Enter an email, username, phone number, or name to search.", "error");
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
      showStatus(
        String(error?.message) === "slow_down"
          ? "Too many searches. Please wait a moment and try again."
          : "Something went wrong searching. Please try again.",
        "error"
      );
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
      item.querySelector(".fp-account-result__email").textContent = account.maskedEmail || "No email on file";

      item.addEventListener("click", () => handleAccountSelected(account));
      resultsList.appendChild(item);
    });

    const returnLink = document.createElement("button");
    returnLink.type = "button";
    returnLink.className = "fp-return-link";
    returnLink.textContent = "Not your account? Return.";
    returnLink.addEventListener("click", resetToSearchStep);
    resultsList.appendChild(returnLink);

    footerBtn.hidden = true;
  }

  function resetToSearchStep() {
    hideStatus();
    resultsList.innerHTML = "";
    searchField.hidden = false;
    footerBtn.hidden = false;
    introEl.textContent = "Enter your email, username, phone number, or name to find your account.";
    searchInput.value = "";
    searchInput.focus();
  }

  async function handleAccountSelected(account) {
    hideStatus();

    if (!account.maskedEmail) {
      showStatus("This account has no email on file. Contact an administrator.", "error");
      return;
    }

    resultsList.innerHTML = "";
    searchField.hidden = true;
    footerBtn.hidden = true;
    introEl.textContent = `Sending a reset link to ${account.maskedEmail}...`;

    try {
      await guardCall("send_reset", { role: account.role, id: account.id });
      introEl.textContent = "Reset link sent!";
      showStatus(`Check the inbox for ${account.maskedEmail} — click the link there to set a new password.`, "success");
    } catch (error) {
      console.error("Couldn't send reset email:", error);
      showStatus(resetErrorMessage(error), "error");
      searchField.hidden = false;
      footerBtn.hidden = false;
      introEl.textContent = "Enter your email, username, phone number, or name to find your account.";
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

// ---- Account search: done on the server; only masked emails come back ----
async function searchAccounts(term) {
  const result = await guardCall("find_accounts", { term });
  return result.accounts || [];
}

function resetErrorMessage(error) {
  const code = String(error?.message || "");
  if (code === "limit") {
    return "You've reached the limit of 5 reset emails for this account. Try again in a while.";
  }
  if (code === "slow_down") return "Too many attempts. Please wait a moment and try again.";
  if (code === "no_email") return "This account has no email on file. Contact an administrator.";
  return "Something went wrong sending the reset link. Please try again.";
}
