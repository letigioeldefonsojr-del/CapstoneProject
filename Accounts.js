import { db, auth, app } from "./firebase-config.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  collection, onSnapshot, doc, setDoc, getDoc, updateDoc, deleteDoc, deleteField, Timestamp, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { confirmDialog } from "./ConfirmDialog.js";
import { resetAttempts } from "./LoginAttempts.js";
import { generateUniqueUsername, isUsernameTaken } from "./UsernameGenerator.js";

// ====================================================================
// ACCOUNT CONTROL (admin-only)
// ----------------------------------------------------------------
// HONEST LIMITATION, worth knowing exactly what this does and doesn't
// do: there's no backend here, so neither action can reach into
// Firebase Authentication itself to disable someone's actual login
// credentials (that's an Admin SDK / Cloud Function capability this
// app doesn't have).
//
//   SUSPEND — writes a suspendedUntil timestamp to their Firestore
//   profile. Enforced at the app level: both login handlers in
//   Index.js check this field and block sign-in with a clear message
//   until it passes. Doesn't stop someone from installing lower-level
//   Firebase access another way, but does correctly stop them from
//   using this app for the chosen duration.
//
//   TERMINATE — permanently deletes their Firestore profile document.
//   Combined with the fix in Sidebar.js (no matching profile = signed
//   out immediately, even mid-session), this makes the account fully
//   unusable in this app going forward — the underlying Firebase Auth
//   login technically still exists, but there's nothing left it can
//   actually do here.
// ====================================================================
let allAccounts = [];
let currentAdminUid = null;
let roleFilter = "all"; // "all" | "admin" | "employee" | "customer"

document.addEventListener("sidebar:ready", (event) => {
  // Admin-only page. The nav link is already hidden for employees
  // (see Sidebar.js), but that alone doesn't stop someone from typing
  // the URL directly — this is the actual enforcement.
  if (event.detail.role !== "admin") {
    window.location.replace("Dashboard.html");
    return;
  }
  currentAdminUid = event.detail.user.uid;
  loadAccounts();
});

function loadAccounts() {
  const container = document.getElementById("accounts-content");
  container.innerHTML = `<p class="forecast-loading">Loading accounts...</p>`;

  let adminDocs = [];
  let employeeDocs = [];
  let customerDocs = [];
  let adminLoaded = false;
  let employeeLoaded = false;
  let customerLoaded = false;

  function mergeAndRender() {
    if (!adminLoaded || !employeeLoaded || !customerLoaded) return; // wait for all three sources before first render
    allAccounts = [...adminDocs, ...employeeDocs, ...customerDocs].sort((a, b) =>
      (a.name || "").localeCompare(b.name || "")
    );
    applyFilterAndRender();
  }

  onSnapshot(
    collection(db, "admins"),
    (snap) => {
      adminDocs = snap.docs.map((d) => ({
        id: d.id,
        role: "admin",
        name: d.data().name,
        email: d.data().email,
        username: d.data().username,
        phone: d.data().phone,
        suspendedUntil: d.data().suspendedUntil
      }));
      adminLoaded = true;
      mergeAndRender();
    },
    (error) => {
      console.error("Couldn't load admin accounts:", error);
      container.innerHTML = `<p class="forecast-loading">Couldn't load accounts right now.</p>`;
    }
  );

  onSnapshot(
    collection(db, "employees"),
    (snap) => {
      employeeDocs = snap.docs.map((d) => ({
        id: d.id,
        role: "employee",
        name: d.data().firstName,
        email: d.data().email,
        username: d.data().username,
        phone: d.data().phone,
        suspendedUntil: d.data().suspendedUntil
      }));
      employeeLoaded = true;
      mergeAndRender();
    },
    (error) => {
      console.error("Couldn't load employee accounts:", error);
      container.innerHTML = `<p class="forecast-loading">Couldn't load accounts right now.</p>`;
    }
  );

  // Customers — from the mobile app's "users" collection (schema
  // confirmed from register_screen.dart: fullName, email,
  // mobileNumber). No "username" concept for customers, so that
  // column just shows their mobile number instead.
  onSnapshot(
    collection(db, "users"),
    (snap) => {
      customerDocs = snap.docs.map((d) => ({
        id: d.id,
        role: "customer",
        name: d.data().fullName,
        email: d.data().email,
        username: d.data().mobileNumber || "—",
        phone: d.data().mobileNumber,
        suspendedUntil: d.data().suspendedUntil
      }));
      customerLoaded = true;
      mergeAndRender();
    },
    (error) => {
      console.error("Couldn't load customer accounts:", error);
      container.innerHTML = `<p class="forecast-loading">Couldn't load accounts right now.</p>`;
    }
  );
}

function applyFilterAndRender() {
  const container = document.getElementById("accounts-content");
  container.innerHTML = "";

  const summary = document.createElement("div");
  summary.className = "forecast-summary-grid";
  const suspendedCount = allAccounts.filter((a) => isCurrentlySuspended(a)).length;
  [
    { value: allAccounts.length, label: "Total Accounts" },
    { value: allAccounts.filter((a) => a.role === "admin").length, label: "Admins" },
    { value: allAccounts.filter((a) => a.role === "employee").length, label: "Employees" },
    { value: allAccounts.filter((a) => a.role === "customer").length, label: "Customers" },
    { value: suspendedCount, label: "Currently Suspended" }
  ].forEach((card) => {
    const el = document.createElement("div");
    el.className = "panel forecast-stat-card";
    el.innerHTML = `<span class="forecast-stat-card__value"></span><span class="forecast-stat-card__label"></span>`;
    el.querySelector(".forecast-stat-card__value").textContent = card.value;
    el.querySelector(".forecast-stat-card__label").textContent = card.label;
    summary.appendChild(el);
  });
  container.appendChild(summary);

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.innerHTML = `
    <div class="feedback-list__header">
      <h3 class="panel__title" style="margin:0;">All Registered Accounts</h3>
      <button type="button" class="btn-primary" id="add-admin-btn">+ Add New Admin</button>
      <select id="accounts-role-filter" class="feedback-sort-select">
        <option value="all">All roles</option>
        <option value="admin">Admin</option>
        <option value="employee">Employee</option>
        <option value="customer">Customer</option>
      </select>
    </div>
    <div class="accounts-table-scroll">
      <table class="inventory-table accounts-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Username</th>
            <th>Role</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="accounts-tbody"></tbody>
      </table>
    </div>
  `;
  container.appendChild(panel);

  const roleFilterSelect = panel.querySelector("#accounts-role-filter");
  roleFilterSelect.value = roleFilter;
  roleFilterSelect.addEventListener("change", (event) => {
    roleFilter = event.target.value;
    applyFilterAndRender();
  });

  panel.querySelector("#add-admin-btn").addEventListener("click", handleAddNewAdmin);

  const tbody = panel.querySelector("#accounts-tbody");
  const visibleAccounts = roleFilter === "all"
    ? allAccounts
    : allAccounts.filter((a) => a.role === roleFilter);

  if (visibleAccounts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="inventory-empty">No accounts found.</td></tr>`;
    return;
  }

  visibleAccounts.forEach((account) => tbody.appendChild(buildAccountRow(account)));
}

function collectionForRole(role) {
  if (role === "admin") return "admins";
  if (role === "employee") return "employees";
  return "users"; // customer
}

function isCurrentlySuspended(account) {
  const millis = account.suspendedUntil?.toMillis?.();
  return millis != null && millis > Date.now();
}

function buildAccountRow(account) {
  const row = document.createElement("tr");
  const isSelf = account.id === currentAdminUid;
  const suspended = isCurrentlySuspended(account);

  row.innerHTML = `
    <td>${escapeHtml(account.name || "(no name)")}</td>
    <td>${escapeHtml(account.email || "—")}</td>
    <td>${escapeHtml(account.username || "—")}</td>
    <td><span class="role-pill role-pill--${account.role}">${account.role === "admin" ? "Admin" : account.role === "employee" ? "Employee" : "Customer"}</span></td>
    <td></td>
    <td><div class="accounts-table__actions"></div></td>
  `;

  const statusCell = row.children[4];
  if (suspended) {
    const untilDate = account.suspendedUntil.toDate();
    const badge = document.createElement("span");
    badge.className = "stock-badge stock-badge--critical";
    badge.textContent = `Suspended until ${untilDate.toLocaleDateString()}`;
    statusCell.appendChild(badge);
  } else {
    const badge = document.createElement("span");
    badge.className = "stock-badge stock-badge--in";
    badge.textContent = "Active";
    statusCell.appendChild(badge);
  }

  const actionsCell = row.children[5].querySelector(".accounts-table__actions");
  if (isSelf) {
    const note = document.createElement("span");
    note.className = "accounts-table__self-note";
    note.textContent = "This is you";
    actionsCell.appendChild(note);
  } else {
    if (suspended) {
      actionsCell.appendChild(buildActionButton("Lift Suspension", "btn-outline", () => handleLiftSuspension(account)));
    } else {
      actionsCell.appendChild(buildActionButton("Suspend", "btn-outline", () => handleSuspend(account)));
    }
    actionsCell.appendChild(buildActionButton("Terminate", "btn-danger-outline", () => handleTerminate(account)));

    // Checked separately from the main render (progressive
    // enhancement) — doesn't block the whole table on N sequential
    // lockout lookups just to show a button most accounts won't need.
    checkAndApplyLockStatus(account, statusCell, actionsCell);
  }

  return row;
}

// Login lockouts are tracked by whatever the person actually TYPED to
// log in (email or username — see LoginAttempts.js), not by account
// ID, so this checks both possible identifiers for this account.
async function checkAndApplyLockStatus(account, statusCell, actionsCell) {
  const identifiers = [account.email, account.username].filter(Boolean);
  if (identifiers.length === 0) return;

  try {
    const snaps = await Promise.all(
      identifiers.map((id) => getDoc(doc(db, "loginAttempts", id.trim().toLowerCase())))
    );

    const lockedSnap = snaps.find((snap) => {
      if (!snap.exists()) return false;
      const data = snap.data();
      if (data.permanentlyLocked) return true;
      const lockedUntilMillis = data.lockedUntil?.toMillis?.();
      return lockedUntilMillis && lockedUntilMillis > Date.now();
    });

    if (!lockedSnap) return; // not locked — nothing to add

    const data = lockedSnap.data();
    const badge = document.createElement("span");
    badge.className = "stock-badge stock-badge--critical";
    badge.textContent = data.permanentlyLocked
      ? "Locked out"
      : `Locked until ${new Date(data.lockedUntil.toMillis()).toLocaleTimeString()}`;
    statusCell.appendChild(badge);

    const unlockBtn = buildActionButton("Unlock", "btn-outline", async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      btn.textContent = "Unlocking...";
      try {
        await resetAttempts(lockedSnap.ref.id);
        badge.remove();
        unlockBtn.remove();
      } catch (error) {
        console.error("Couldn't unlock account:", error);
        btn.disabled = false;
        btn.textContent = "Unlock";
      }
    });
    actionsCell.insertBefore(unlockBtn, actionsCell.firstChild);
  } catch (error) {
    console.error("Couldn't check lockout status:", error);
  }
}

function buildActionButton(label, className, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

// ---- Suspend (asks for a number of days + a reason via a small custom modal) ----
const PRESET_REASONS = [
  "Policy violation",
  "Suspicious activity",
  "Repeated complaints",
  "Fraudulent activity",
  "Non-payment / billing issue",
  "Other (please specify)"
];

function buildReasonFieldHtml(idPrefix) {
  return `
    <div class="form-field" style="margin-top: 14px;">
      <label for="${idPrefix}-reason-select">Reason</label>
      <select id="${idPrefix}-reason-select">
        ${PRESET_REASONS.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join("")}
      </select>
    </div>
    <div class="form-field" id="${idPrefix}-reason-custom-field" hidden>
      <label for="${idPrefix}-reason-custom">Specify reason</label>
      <textarea id="${idPrefix}-reason-custom" rows="2" placeholder="Describe the reason"></textarea>
    </div>
  `;
}

function wireReasonField(overlay, idPrefix) {
  const select = overlay.querySelector(`#${idPrefix}-reason-select`);
  const customField = overlay.querySelector(`#${idPrefix}-reason-custom-field`);
  select.addEventListener("change", () => {
    customField.hidden = select.value !== "Other (please specify)";
  });
}

function getSelectedReason(overlay, idPrefix) {
  const select = overlay.querySelector(`#${idPrefix}-reason-select`);
  if (select.value === "Other (please specify)") {
    return overlay.querySelector(`#${idPrefix}-reason-custom`).value.trim();
  }
  return select.value;
}

// ====================================================================
// ADD NEW ADMIN
// ----------------------------------------------------------------
// Admin accounts can no longer be self-registered (the public signup
// form was removed) — this is now the only way a new admin account
// gets created, and only an already-logged-in admin can do it.
//
// TECHNICAL NOTE: creating a Firebase Auth user via the normal client
// SDK automatically signs in AS that new user on whatever auth
// instance you call it on — which would immediately log the CURRENT
// admin out and replace their session with the brand new account.
// This uses a SEPARATE, temporary secondary Firebase App instance
// specifically for the creation step, so the primary app (and the
// current admin's actual session) is never touched. The temporary
// instance is torn down immediately after, win or lose.
// ====================================================================
function generateTempPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let result = "";
  for (let i = 0; i < 12; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function handleAddNewAdmin() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const tempPassword = generateTempPassword();

  overlay.innerHTML = `
    <div class="modal">
      <div class="modal__header">
        <h3>Add New Admin</h3>
        <button type="button" class="modal__close" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modal__body">
        <div class="form-field">
          <label for="new-admin-name">Full name</label>
          <input type="text" id="new-admin-name" placeholder="Enter their full name">
        </div>
        <div class="form-field" style="margin-top: 12px;">
          <label for="new-admin-email">Email</label>
          <input type="email" id="new-admin-email" placeholder="Enter their email">
        </div>
        <div class="form-field" style="margin-top: 12px;">
          <label for="new-admin-username">Username</label>
          <input type="text" id="new-admin-username" placeholder="Auto-filled from their name — edit if you like">
        </div>
        <div class="form-field" style="margin-top: 12px;">
          <label for="new-admin-temp-password">Temporary password</label>
          <input type="text" id="new-admin-temp-password" value="${tempPassword}">
          <p style="font-size:11.5px; color:var(--muted); margin:4px 0 0;">Auto-generated — share this with them so they can log in, and ask them to change it right away. Editable if you'd rather set your own.</p>
        </div>
        <p class="form-status" id="new-admin-status" hidden></p>
      </div>
      <div class="modal__footer">
        <button type="button" class="btn-outline" data-action="cancel">Cancel</button>
        <button type="button" class="btn-primary" data-action="confirm">Create Admin Account</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const nameInput = overlay.querySelector("#new-admin-name");
  const usernameInput = overlay.querySelector("#new-admin-username");
  const statusEl = overlay.querySelector("#new-admin-status");
  nameInput.focus();

  let usernameManuallyEdited = false;
  usernameInput.addEventListener("input", () => { usernameManuallyEdited = true; });
  nameInput.addEventListener("blur", async () => {
    if (usernameManuallyEdited || !nameInput.value.trim()) return;
    usernameInput.value = await generateUniqueUsername(nameInput.value.trim(), 0);
  });

  function close() { overlay.remove(); }
  overlay.querySelector(".modal__close").addEventListener("click", close);
  overlay.querySelector('[data-action="cancel"]').addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  overlay.querySelector('[data-action="confirm"]').addEventListener("click", async (event) => {
    const name = nameInput.value.trim();
    const email = overlay.querySelector("#new-admin-email").value.trim();
    const username = usernameInput.value.trim();
    const password = overlay.querySelector("#new-admin-temp-password").value;

    if (!name || !email || !username || !password) {
      statusEl.textContent = "Fill in every field.";
      statusEl.dataset.kind = "error";
      statusEl.hidden = false;
      return;
    }
    if (password.length < 8) {
      statusEl.textContent = "Password must be at least 8 characters.";
      statusEl.dataset.kind = "error";
      statusEl.hidden = false;
      return;
    }

    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = "Creating...";

    // A uniquely-named secondary app each time, so overlapping usage
    // (unlikely, but possible) never collides with a leftover instance.
    const secondaryApp = initializeApp(app.options, `AddAdmin-${Date.now()}`);
    const secondaryAuth = getAuth(secondaryApp);

    try {
      if (await isUsernameTaken(username)) {
        statusEl.textContent = "That username is already taken. Try a different one.";
        statusEl.dataset.kind = "error";
        statusEl.hidden = false;
        return;
      }

      const result = await createUserWithEmailAndPassword(secondaryAuth, email, password);
      const newUid = result.user.uid;

      await setDoc(doc(db, "admins", newUid), {
        name,
        email,
        username,
        role: "admin",
        createdAt: serverTimestamp()
      });

      // The temporary instance signed itself in as the new admin the
      // moment it was created — sign that out before tearing the
      // instance down, so there's no lingering active session for it.
      await signOut(secondaryAuth);

      close();
    } catch (error) {
      console.error("Couldn't create admin account:", error);
      statusEl.textContent = error.code === "auth/email-already-in-use"
        ? "That email is already registered."
        : "Something went wrong. Please try again.";
      statusEl.dataset.kind = "error";
      statusEl.hidden = false;
      btn.disabled = false;
      btn.textContent = "Create Admin Account";
    } finally {
      // Always torn down, whether creation succeeded or failed —
      // never leaves an orphaned secondary app instance behind.
      await deleteApp(secondaryApp);
    }
  });
}

function handleSuspend(account) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal__header">
        <h3>Suspend ${escapeHtml(account.name || "this account")}?</h3>
        <button type="button" class="modal__close" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modal__body">
        <p class="confirm-dialog__message">${account.role === "customer"
          ? "They won't be able to log in on the mobile app (any sign-in method) until the suspension ends."
          : "They won't be able to log in until the suspension ends."}</p>
        <div class="form-field" style="margin-top: 14px;">
          <label for="suspend-days-input">Number of days</label>
          <input type="number" id="suspend-days-input" min="1" step="1" value="7">
        </div>
        ${buildReasonFieldHtml("suspend")}
        <p class="form-status" id="suspend-status" hidden></p>
      </div>
      <div class="modal__footer">
        <button type="button" class="btn-outline" data-action="cancel">Cancel</button>
        <button type="button" class="btn-danger-outline" data-action="confirm">Suspend Account</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const daysInput = overlay.querySelector("#suspend-days-input");
  const statusEl = overlay.querySelector("#suspend-status");
  wireReasonField(overlay, "suspend");
  daysInput.focus();

  function close() { overlay.remove(); }
  overlay.querySelector(".modal__close").addEventListener("click", close);
  overlay.querySelector('[data-action="cancel"]').addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  overlay.querySelector('[data-action="confirm"]').addEventListener("click", async (event) => {
    const days = parseInt(daysInput.value, 10);
    if (!Number.isFinite(days) || days < 1) {
      statusEl.textContent = "Enter a valid number of days (1 or more).";
      statusEl.dataset.kind = "error";
      statusEl.hidden = false;
      return;
    }

    const reason = getSelectedReason(overlay, "suspend");
    if (!reason) {
      statusEl.textContent = "Enter a reason.";
      statusEl.dataset.kind = "error";
      statusEl.hidden = false;
      return;
    }

    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = "Suspending...";

    try {
      const untilDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      const suspendedUntil = Timestamp.fromDate(untilDate);
      await updateDoc(doc(db, collectionForRole(account.role), account.id), {
        suspendedUntil,
        suspensionReason: reason
      });
      await sendAccountActionEmail(account, "suspended", reason, untilDate);
      close();
    } catch (error) {
      console.error("Couldn't suspend account:", error);
      statusEl.textContent = "Something went wrong. Please try again.";
      statusEl.dataset.kind = "error";
      statusEl.hidden = false;
      btn.disabled = false;
      btn.textContent = "Suspend Account";
    }
  });
}

async function handleLiftSuspension(account) {
  const confirmed = await confirmDialog(
    `Lift the suspension on ${account.name || "this account"}? They'll be able to log in again immediately.`,
    { title: "Lift suspension?", confirmLabel: "Lift Suspension" }
  );
  if (!confirmed) return;

  try {
    await updateDoc(doc(db, collectionForRole(account.role), account.id), {
      suspendedUntil: deleteField()
    });
  } catch (error) {
    console.error("Couldn't lift suspension:", error);
  }
}

function handleTerminate(account) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal__header">
        <h3>Terminate ${escapeHtml(account.name || "this account")}?</h3>
        <button type="button" class="modal__close" aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6 6L18 18M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="modal__body">
        <p class="confirm-dialog__message">Their profile will be permanently deleted and they'll be signed out immediately if currently logged in. This can't be undone.</p>
        ${buildReasonFieldHtml("terminate")}
        <p class="form-status" id="terminate-status" hidden></p>
      </div>
      <div class="modal__footer">
        <button type="button" class="btn-outline" data-action="cancel">Cancel</button>
        <button type="button" class="btn-danger-outline" data-action="confirm">Terminate</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const statusEl = overlay.querySelector("#terminate-status");
  wireReasonField(overlay, "terminate");

  function close() { overlay.remove(); }
  overlay.querySelector(".modal__close").addEventListener("click", close);
  overlay.querySelector('[data-action="cancel"]').addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  overlay.querySelector('[data-action="confirm"]').addEventListener("click", async (event) => {
    const reason = getSelectedReason(overlay, "terminate");
    if (!reason) {
      statusEl.textContent = "Enter a reason.";
      statusEl.dataset.kind = "error";
      statusEl.hidden = false;
      return;
    }

    const btn = event.currentTarget;
    btn.disabled = true;
    btn.textContent = "Terminating...";

    try {
      // Send the email BEFORE deleting — once the profile doc is gone,
      // we no longer have their email address to send anything to.
      await sendAccountActionEmail(account, "terminated", reason, null);
      await deleteDoc(doc(db, collectionForRole(account.role), account.id));
      close();
    } catch (error) {
      console.error("Couldn't terminate account:", error);
      statusEl.textContent = "Something went wrong. Please try again.";
      statusEl.dataset.kind = "error";
      statusEl.hidden = false;
      btn.disabled = false;
      btn.textContent = "Terminate";
    }
  });
}

// ====================================================================
// ACCOUNT ACTION EMAIL (suspend/terminate notification)
// ----------------------------------------------------------------
// Uses a dedicated EmailJS template (confirmed set up, not the OTP
// one — that one is built specifically around a {{passcode}}/{{time}}
// verification code, wrong shape for an account-status notice).
// Variables sent: to_email, name, action, reason, until_date.
// ====================================================================
const ACCOUNT_EMAIL_TEMPLATE_ID = "template_aigi7ef";
const EMAILJS_SERVICE_ID = "service_mmg4ncm"; // same service as the OTP emails — only the template differs

async function sendAccountActionEmail(account, action, reason, untilDate) {
  if (!account.email) {
    console.warn("No email on file — skipping account action notification.");
    return;
  }

  try {
    if (!window.emailjs) throw new Error("EmailJS SDK not loaded");
    window.emailjs.init({ publicKey: "D66Nq0gpzysnBwvyP" });

    await window.emailjs.send(EMAILJS_SERVICE_ID, ACCOUNT_EMAIL_TEMPLATE_ID, {
      to_email: account.email,
      name: account.name || "",
      action: action === "suspended" ? "Suspended" : "Terminated",
      reason,
      until_date: untilDate ? untilDate.toLocaleDateString() : ""
    });
  } catch (error) {
    // Deliberately doesn't block or fail the actual suspend/terminate
    // action — the account status change already succeeded in
    // Firestore by the time this runs. A failed notification email
    // shouldn't undo that or confuse the admin with an error for
    // something that actually worked.
    console.error("Couldn't send account action email:", error);
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
