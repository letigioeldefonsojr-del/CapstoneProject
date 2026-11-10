// autofill — Stops the browser from auto-filling saved logins into the wrong fields.

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

  [0, 100, 300, 700, 1500, 3000].forEach((ms) => setTimeout(clearAll, ms));
  window.addEventListener("pageshow", clearAll);
}
