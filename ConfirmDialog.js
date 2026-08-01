// ====================================================================
// IN-APP CONFIRMATION DIALOG
// ----------------------------------------------------------------
// Replaces window.confirm() everywhere — that native dialog shows the
// page's URL ("127.0.0.1:5500 says...") and can't be styled at all.
// This builds a real modal instead, reusing the app's existing
// .modal / .modal-overlay classes, and resolves a Promise<boolean>
// the same way confirm() returns a boolean, so call sites just need
// `await confirmDialog(...)` in place of `window.confirm(...)`.
//
// Built and torn down dynamically (appended to <body>, removed after
// the user answers) rather than toggling a `hidden` attribute on a
// pre-existing element — this sidesteps the whole [hidden] vs
// explicit-display CSS conflict category of bug entirely.
// ====================================================================

let activeResolve = null;

export function confirmDialog(message, options = {}) {
  const {
    title = "Please confirm",
    confirmLabel = "OK",
    cancelLabel = "Cancel",
    danger = false
  } = options;

  return new Promise((resolve) => {
    // Safety: if somehow a dialog is already open, resolve it as
    // cancelled before opening a new one, rather than leaking it.
    if (activeResolve) activeResolve(false);
    activeResolve = resolve;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay confirm-overlay";
    overlay.innerHTML = `
      <div class="modal confirm-dialog">
        <div class="modal__header">
          <h3></h3>
        </div>
        <div class="modal__body">
          <p class="confirm-dialog__message"></p>
        </div>
        <div class="modal__footer">
          <button type="button" class="btn-outline" data-action="cancel"></button>
          <button type="button" data-action="confirm"></button>
        </div>
      </div>
    `;

    overlay.querySelector(".modal__header h3").textContent = title;
    overlay.querySelector(".confirm-dialog__message").textContent = message;
    overlay.querySelector('[data-action="cancel"]').textContent = cancelLabel;

    const confirmBtn = overlay.querySelector('[data-action="confirm"]');
    confirmBtn.textContent = confirmLabel;
    confirmBtn.className = danger ? "btn-danger-outline" : "btn-primary";

    function cleanup(result) {
      overlay.remove();
      document.removeEventListener("keydown", onKeydown);
      activeResolve = null;
      resolve(result);
    }

    function onKeydown(event) {
      if (event.key === "Escape") cleanup(false);
      if (event.key === "Enter") cleanup(true);
    }

    overlay.querySelector('[data-action="cancel"]').addEventListener("click", () => cleanup(false));
    confirmBtn.addEventListener("click", () => cleanup(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) cleanup(false);
    });
    document.addEventListener("keydown", onKeydown);

    document.body.appendChild(overlay);
    confirmBtn.focus();
  });
}
