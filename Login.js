// login — One sign-in box: finds out whether the person is an admin, employee or customer and sends them to the right page.

import { guardCall } from "./LoginGuard.js?v=20261030d";

const statusEl = document.getElementById("form-status");
const form = document.getElementById("form-identify");
const input = document.getElementById("identifier");
const button = document.getElementById("identify-submit");
const label = button.querySelector(".login-btn__label");

function showStatus(message, withSignup = false) {
  statusEl.textContent = message;
  if (withSignup) {
    statusEl.append(" New staff member? ");
    const link = document.createElement("a");
    link.href = "EmployeeLogin?signup=1";
    link.textContent = "Register here";
    link.style.cssText = "color:#fff;font-weight:700;text-decoration:underline;";
    statusEl.append(link, ".");
  }
  statusEl.dataset.kind = "error";
  statusEl.hidden = false;
}

const go = (page, id) => window.location.assign(`${page}?u=${encodeURIComponent(id)}`);

async function lookup(kind, id) {
  try {
    const result = await guardCall("resolve_login", { kind, id });
    return result.found === true;
  } catch (error) {
    if (String(error?.message) === "slow_down") throw error;
    console.error(`Lookup failed (${kind}):`, error);
    return false;
  }
}

async function identify(id) {
  const digits = id.replace(/\D/g, "");
  const looksLikeMobile = !id.includes("@") && /^(\+?63|0)?9\d{9}$/.test(digits);

  if (looksLikeMobile) {
    const customer = await guardCall("customer_resolve", { mobile: digits });
    return customer.found ? "Shop" : null;
  }
  if (await lookup("admin", id)) return "AdminLogin";
  if (await lookup("employee", id)) return "EmployeeLogin";
  if (id.includes("@")) {
    const taken = await guardCall("customer_taken", { email: id });
    if (taken.emailTaken) return "Shop";
  }
  return null;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusEl.hidden = true;
  const id = input.value.trim();
  if (!id) { showStatus("Enter your username, email or mobile number."); return; }

  button.disabled = true;
  label.textContent = "Checking...";
  try {
    const page = await identify(id);
    if (!page) {
      showStatus("We couldn't find an account with that. Check it and try again, or create a customer account below.");
      return;
    }
    go(page, id);
  } catch (error) {
    console.error("Sign-in lookup failed:", error);
    showStatus(String(error?.message) === "slow_down"
      ? "Too many attempts. Please wait a moment and try again."
      : "Something went wrong. Please try again.");
  } finally {
    button.disabled = false;
    label.textContent = "Continue";
  }
});

input.focus();
