// ====================================================================
// AUTOFILL GUARD
// ----------------------------------------------------------------
// Browsers (Chrome especially) fill a saved login into the page the
// moment it opens. That puts a password on screen with nobody asking
// for it. This keeps those boxes empty until the person actually
// interacts with them:
//   - anything that appears BEFORE they click/tap/type in one of the
//     boxes is cleared;
//   - once they click into a box, the browser's suggestion list shows
//     and picking a saved login fills the boxes normally.
// Pass the ids of every box in one form (username + password).
// ====================================================================
export function guardAutofill(ids) {
  const inputs = ids.map((id) => document.getElementById(id)).filter(Boolean);
  if (inputs.length === 0) return;

  let touched = false;
  const clearAll = () => {
    if (touched) return;
    inputs.forEach((input) => { if (input.value) input.value = ""; });
  };

  inputs.forEach((input) => {
    ["pointerdown", "touchstart", "focus", "keydown"].forEach((evt) =>
      input.addEventListener(evt, () => { touched = true; }, { passive: true }));
    // Autofill fires these without any pointer/keyboard event first.
    input.addEventListener("input", clearAll);
    input.addEventListener("change", clearAll);
    input.addEventListener("animationstart", (event) => {
      if (event.animationName === "onAutofillDetected") clearAll();
    });
  });

  // Autofill can land a moment after load, and not every browser fires
  // an event for it, so sweep a few times as well.
  [0, 100, 300, 700, 1500, 3000].forEach((ms) => setTimeout(clearAll, ms));
  window.addEventListener("pageshow", clearAll);
}
