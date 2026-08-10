// ====================================================================
// PASSWORD STRENGTH VALIDATION
// ----------------------------------------------------------------
// Requires: 8+ characters, at least one uppercase, one lowercase, one
// digit, one special character. Also rejects a small list of common
// weak passwords, and rejects passwords containing the person's own
// name or a birthday-shaped year (1900-2099) — the two specific
// things asked for beyond raw complexity rules.
//
// Honest limit: this can only catch what's actually detectable from
// the password text itself. It can't know someone's real birthday if
// they don't type a year-shaped number, and it can only check against
// the name typed into the SAME form — not some other name/nickname.
// ====================================================================
const COMMON_WEAK_PASSWORDS = new Set([
  "password", "password1", "password123", "12345678", "123456789",
  "1234567890", "qwerty123", "qwertyui", "letmein1", "welcome1",
  "admin123", "iloveyou1", "abc123456", "changeme1", "p@ssw0rd"
]);

export function validatePasswordStrength(password, fullName) {
  if (password.length < 8) {
    return { valid: false, message: "Password must be at least 8 characters." };
  }

  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);

  if (!hasUpper || !hasLower || !hasDigit || !hasSpecial) {
    return {
      valid: false,
      message: "Password must include an uppercase letter, a lowercase letter, a number, and a special character."
    };
  }

  const lowerPassword = password.toLowerCase();

  if (COMMON_WEAK_PASSWORDS.has(lowerPassword)) {
    return { valid: false, message: "That password is too common. Please choose a more unique one." };
  }

  // Shouldn't contain the person's own name (checked word-by-word,
  // ignoring short words like initials/"de"/"la" to avoid false
  // positives on very short name parts).
  if (fullName) {
    const nameParts = fullName.toLowerCase().split(/\s+/).filter((part) => part.length >= 3);
    for (const part of nameParts) {
      if (lowerPassword.includes(part)) {
        return { valid: false, message: "Password shouldn't contain your name." };
      }
    }
  }

  // Crude but useful birthday/date heuristic: a 4-digit run that
  // looks like a plausible birth year (1900-2099) embedded anywhere
  // in the password.
  if (/19\d{2}|20\d{2}/.test(password)) {
    return { valid: false, message: "Password shouldn't be based on a birthday or date." };
  }

  return { valid: true, message: "" };
}
