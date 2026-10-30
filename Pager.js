// ====================================================================
// PAGER: "Rows per page [50]   1–50 of 128   <  >"
// Shared by the Orders and Sales pages.
// ====================================================================
export const PAGE_SIZES = [25, 50, 100];

export function pageSlice(items, page, perPage) {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

// Keeps the page number inside 1..lastPage.
export function clampPage(page, total, perPage) {
  const last = Math.max(1, Math.ceil(total / perPage));
  return Math.min(Math.max(1, page), last);
}

// Draws the pager into `el`. Callbacks: onPage(newPage), onSize(newPerPage).
export function renderPager(el, { total, page, perPage, onPage, onSize }) {
  if (!el) return;
  el.replaceChildren();
  el.className = "pager";

  const sizeLabel = document.createElement("span");
  sizeLabel.textContent = "Rows per page";
  const select = document.createElement("select");
  select.className = "pager__select";
  select.setAttribute("aria-label", "Rows per page");
  PAGE_SIZES.forEach((n) => {
    const o = document.createElement("option");
    o.value = String(n);
    o.textContent = String(n);
    if (n === perPage) o.selected = true;
    select.appendChild(o);
  });
  select.addEventListener("change", () => onSize(Number(select.value)));

  const from = total === 0 ? 0 : (page - 1) * perPage + 1;
  const to = Math.min(page * perPage, total);
  const range = document.createElement("span");
  range.className = "pager__range";
  range.textContent = `${from}–${to} of ${total}`;

  const last = Math.max(1, Math.ceil(total / perPage));
  const mk = (label, text, disabled, target) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pager__btn";
    b.textContent = text;
    b.setAttribute("aria-label", label);
    b.disabled = disabled;
    b.addEventListener("click", () => onPage(target));
    return b;
  };

  el.append(
    sizeLabel, select, range,
    mk("Previous page", "‹", page <= 1, page - 1),
    mk("Next page", "›", page >= last, page + 1)
  );
}
