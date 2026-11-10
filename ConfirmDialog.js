// confirm — In-app confirmation dialog replacing window.confirm.

let activeResolve = null;

export function confirmDialog(message, options = {}) {
  const {
    title = "Please confirm",
    confirmLabel = "OK",
    cancelLabel = "Cancel",
    danger = false
  } = options;

  return new Promise((resolve) => {
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
