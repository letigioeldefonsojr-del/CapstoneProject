import { db } from "./firebase-config.js";
import {
  collection, addDoc, updateDoc, doc, writeBatch, serverTimestamp, runTransaction,
  getDocs, query, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getProducts, invalidateProductsCache } from "./ProductCache.js";
import { confirmDialog } from "./ConfirmDialog.js";

// ====================================================================
// CHUNK 0 — CONFIG
// Field names confirmed against a real product document:
// name, category, price (already a formatted string, e.g. "₱45.00"),
// stockCount, available (boolean), imageUrl.
//
// VARIANT PRODUCTS (flavors array): I haven't seen a real example of
// what's inside one flavor entry, so this guesses the same field
// names as the parent product (name/price/stockCount/available) per
// entry, and falls back gracefully if an entry is just a plain
// string instead of an object. If variants render oddly, share one
// expanded "flavors" array from the Firestore console and I'll fix
// these field names to match.
//
// STOCK TIERS: In Stock > Low Stock > Critically Low Stock > Out of
// Stock, based on these two thresholds. Adjust to taste.
//
// ADMIN EDITING SCOPE: Add/Edit/Bulk-Import all work on simple
// (non-variant) products. Editing individual flavor variants isn't
// built yet — that's a reasonable follow-up once you confirm the
// real shape of a flavor entry (see note above).
// ====================================================================
const PRODUCTS_COLLECTION     = "products";
const PRODUCT_NAME_FIELD      = "name";
const PRODUCT_CATEGORY_FIELD  = "category";
const PRODUCT_PRICE_FIELD     = "price";
const PRODUCT_AVAILABLE_FIELD = "available";
const PRODUCT_IMAGE_FIELD     = "imageUrl";
const PRODUCT_VARIANTS_FIELD  = "flavors";
const BARCODE_FIELD           = "barcode"; // same field name at parent and variant level
const STOCK_MOVEMENTS_COLLECTION = "stockMovements";
const STOCK_FIELD             = "stockCount"; // parent product's own stock field
const VARIANT_STOCK_FIELD     = "stock";       // a flavor entry's stock field — CONFIRMED from
                                                // your mobile app's readStockDeduction() function.
                                                // Different name than the parent's STOCK_FIELD —
                                                // don't merge these into one constant.
const LOW_STOCK_THRESHOLD      = 99; // at or below this (and above critical) = "Low Stock"
const CRITICAL_STOCK_THRESHOLD = 49; // at or below this (and above 0) = "Critically Low Stock"

const STATUS_LABELS = {
  in: "In Stock",
  low: "Low Stock",
  critical: "Critically Low Stock",
  out: "Out of Stock",
  unknown: "Stock Not Set"
};

// Cloudinary — used for uploading product images from Add/Edit Product.
// Cloud name confirmed from your existing product data
// (res.cloudinary.com/h5291fss/...). Unsigned upload preset "productsweb"
// uploads straight from the browser with no server involved and no
// secret key exposed client-side.
const CLOUDINARY_CLOUD_NAME = "h5291fss";
const CLOUDINARY_UPLOAD_PRESET = "productsweb";
const CLOUDINARY_FOLDER = "products";
const MAX_IMAGE_SIZE_MB = 8;

// CSV bulk-import column mapping — matches the header row you shared:
// sku, description, category, principal, unit, qty, qty 1, qty 2,
// unit_price, unit_ws. "description" is treated as the product name
// (no separate "name" column existed). qty1/qty2/wholesalePrice are
// stored as extra fields since their exact meaning wasn't specified —
// adjust CSV_COLUMN_MAP below if that guess is wrong.
const CSV_COLUMN_MAP = {
  sku: "sku",
  description: "name",
  category: "category",
  principal: "principal",
  unit: "unit",
  qty: "stockCount",
  "qty 1": "qty1",
  "qty 2": "qty2",
  unit_price: "price",
  unit_ws: "wholesalePrice"
};

let allProducts = [];
let expandedVariantRow = null;   // accordion: only one product's variant row open at a time
let expandedVariantMainRow = null;
let isAdmin = false;
let currentUser = null;
let currentUserRole = "employee";
let editOriginalProduct = null; // snapshot of the product before an Edit, used to log what changed
let editingProductId = null; // null = Add mode, a product id = Edit mode
let parsedCsvRows = [];      // rows staged for the CSV preview/confirm step

// ====================================================================
// CHUNK 0B — FORCE-CLOSE MODALS ON PAGE ENTRY
// ----------------------------------------------------------------
// If a modal was left open and the browser restores this page from
// its back-forward cache (bfcache) — e.g. navigating away and then
// hitting Back — it can restore the exact DOM snapshot, modals and
// all, without re-running this script. That leaves an invisible
// full-screen overlay blocking every click on the page. Closing both
// modals unconditionally here, on every entry to this page, prevents
// that regardless of how the page was reached.
// ====================================================================
function forceCloseAllModals() {
  const productModal = document.getElementById("product-modal-overlay");
  const csvModal = document.getElementById("csv-modal-overlay");
  const scannerModal = document.getElementById("scanner-modal-overlay");
  const stockLogModal = document.getElementById("stock-log-modal-overlay");
  if (productModal) productModal.hidden = true;
  if (csvModal) csvModal.hidden = true;
  if (scannerModal) scannerModal.hidden = true;
  if (stockLogModal) stockLogModal.hidden = true;
  document.getElementById("product-form")?.reset();
  editOriginalProduct = null;
  const preview = document.getElementById("pf-image-preview");
  if (preview) preview.innerHTML = `<span class="image-preview__empty">No image</span>`;
  const uploadStatus = document.getElementById("pf-image-upload-status");
  if (uploadStatus) { uploadStatus.textContent = ""; delete uploadStatus.dataset.kind; }
  document.getElementById("csv-status")?.setAttribute("hidden", "");
  document.getElementById("variant-editor-list")?.replaceChildren();
  const hasVariantsCheckbox = document.getElementById("pf-has-variants");
  if (hasVariantsCheckbox) hasVariantsCheckbox.checked = false;
  document.getElementById("simple-price-field")?.removeAttribute("hidden");
  document.getElementById("simple-stock-field")?.removeAttribute("hidden");
  document.getElementById("variant-editor-field")?.setAttribute("hidden", "");
  parsedCsvRows = [];
}

forceCloseAllModals();

window.addEventListener("pageshow", (event) => {
  if (event.persisted) forceCloseAllModals();
});

// ====================================================================
// CHUNK 1 — WAIT FOR THE SHARED SIDEBAR (auth guard lives there)
// ====================================================================
document.addEventListener("sidebar:ready", (event) => {
  isAdmin = event.detail.role === "admin";
  currentUserRole = event.detail.role;
  currentUser = event.detail.user;
  loadInventory();
  wireControls();
  wireScanner();
  wireStockLog();
  if (isAdmin) wireAdminControls();
});

// ====================================================================
// CHUNK 2 — LOAD (via the shared cache — see ProductCache.js. On a
// cache hit this resolves near-instantly with zero network request.)
// ====================================================================
async function loadInventory() {
  try {
    allProducts = await getProducts();
    populateCategoryFilter(allProducts);
    applyUrlFilter();
    applyFiltersAndRender();
  } catch (error) {
    console.error("Couldn't load products:", error);
    document.getElementById("inventory-tbody").innerHTML =
      `<tr><td colspan="5" class="inventory-empty">Couldn't load products right now.</td></tr>`;
  }
}

async function reloadAfterWrite() {
  invalidateProductsCache();
  allProducts = await getProducts();
  populateCategoryFilter(allProducts);
  applyFiltersAndRender();
}

// ====================================================================
// CHUNK 2B — STOCK CLASSIFICATION (single source of truth)
// ----------------------------------------------------------------
// Returns "out" | "critical" | "low" | "in". Every badge, filter, and
// summary in this file goes through this one function so the tiers
// can never drift out of sync with each other.
// ====================================================================
function getStockStatus(stock, isAvailable) {
  if (isAvailable === false || stock === 0) return "out";
  if (typeof stock !== "number") return "unknown";
  if (stock <= CRITICAL_STOCK_THRESHOLD) return "critical";
  if (stock <= LOW_STOCK_THRESHOLD) return "low";
  return "in";
}

// ====================================================================
// CHUNK 2C — URL-DRIVEN FILTER (?filter=attention)
// ====================================================================
function applyUrlFilter() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("filter");
  if (!requested) return;

  const select = document.getElementById("inventory-stock-filter");
  const validValues = Array.from(select.options).map((o) => o.value);
  if (validValues.includes(requested)) select.value = requested;
}

// ====================================================================
// CHUNK 3 — SEARCH + CATEGORY + STOCK STATUS FILTER + SORT
// ====================================================================
function wireControls() {
  document.getElementById("inventory-search").addEventListener("input", applyFiltersAndRender);
  document.getElementById("inventory-category").addEventListener("change", applyFiltersAndRender);
  document.getElementById("inventory-stock-filter").addEventListener("change", applyFiltersAndRender);
  document.getElementById("inventory-sort").addEventListener("change", applyFiltersAndRender);
}

function populateCategoryFilter(products) {
  const select = document.getElementById("inventory-category");
  const currentValue = select.value;
  select.querySelectorAll("option:not(:first-child)").forEach((opt) => opt.remove());

  const categories = [...new Set(
    products.map((p) => p[PRODUCT_CATEGORY_FIELD]).filter(Boolean)
  )].sort();

  categories.forEach((category) => {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    select.appendChild(option);
  });

  if ([...select.options].some((o) => o.value === currentValue)) {
    select.value = currentValue;
  }
}

function applyFiltersAndRender() {
  const term = document.getElementById("inventory-search").value.trim().toLowerCase();
  const category = document.getElementById("inventory-category").value;
  const stockFilter = document.getElementById("inventory-stock-filter").value;
  const sortBy = document.getElementById("inventory-sort").value;

  let filtered = allProducts.filter((product) => {
    const name = (product[PRODUCT_NAME_FIELD] || "").toLowerCase();
    const matchesSearch = name.includes(term);
    const matchesCategory = category === "all" || product[PRODUCT_CATEGORY_FIELD] === category;
    const matchesStock = productMatchesStockFilter(product, stockFilter);
    return matchesSearch && matchesCategory && matchesStock;
  });

  filtered = sortProducts(filtered, sortBy);
  renderInventoryTable(filtered, stockFilter);
}

function productMatchesStockFilter(product, stockFilter) {
  if (stockFilter === "all") return true;

  const variants = getVariants(product);
  if (variants.length > 0) {
    return variants.some((v) => variantMatchesStockFilter(v, stockFilter));
  }

  const status = getStockStatus(product[STOCK_FIELD], product[PRODUCT_AVAILABLE_FIELD]);
  return matchesFilterValue(status, stockFilter);
}

function variantMatchesStockFilter(variant, stockFilter) {
  if (!variant || typeof variant !== "object") return false;
  const status = getStockStatus(variant[VARIANT_STOCK_FIELD], variant[PRODUCT_AVAILABLE_FIELD]);
  return matchesFilterValue(status, stockFilter);
}

function matchesFilterValue(status, stockFilter) {
  if (stockFilter === "attention") return status !== "in";
  return status === stockFilter;
}

function getVariants(product) {
  return Array.isArray(product[PRODUCT_VARIANTS_FIELD]) ? product[PRODUCT_VARIANTS_FIELD] : [];
}

function sortProducts(products, sortBy) {
  const sorted = [...products];

  sorted.sort((a, b) => {
    switch (sortBy) {
      case "name-desc":
        return (b[PRODUCT_NAME_FIELD] || "").localeCompare(a[PRODUCT_NAME_FIELD] || "");
      case "stock-asc":
        return numericStock(a) - numericStock(b);
      case "stock-desc":
        return numericStock(b) - numericStock(a);
      case "price-asc":
        return numericPrice(a) - numericPrice(b);
      case "price-desc":
        return numericPrice(b) - numericPrice(a);
      case "name-asc":
      default:
        return (a[PRODUCT_NAME_FIELD] || "").localeCompare(b[PRODUCT_NAME_FIELD] || "");
    }
  });

  return sorted;
}

function numericStock(product) {
  const variants = getVariants(product);
  if (variants.length > 0) {
    return variants.reduce((sum, v) => sum + (typeof v[VARIANT_STOCK_FIELD] === "number" ? v[VARIANT_STOCK_FIELD] : 0), 0);
  }
  return typeof product[STOCK_FIELD] === "number" ? product[STOCK_FIELD] : -1;
}

function numericPrice(product) {
  const raw = product[PRODUCT_PRICE_FIELD];
  const parsed = parseFloat(String(raw || "").replace(/[^\d.]/g, ""));
  return isNaN(parsed) ? -1 : parsed;
}

// ====================================================================
// CHUNK 4 — RENDER TABLE
// ----------------------------------------------------------------
// The Actions column (Edit button) only renders for admin, and only
// on simple products — not on variant breakdown rows (see CHUNK 0
// note on admin editing scope).
// ====================================================================
function renderInventoryTable(products, stockFilter) {
  const tbody = document.getElementById("inventory-tbody");
  const countLabel = document.getElementById("inventory-count");
  document.getElementById("actions-header").hidden = !isAdmin;
  expandedVariantRow = null;
  expandedVariantMainRow = null;

  countLabel.textContent = `${products.length} product${products.length === 1 ? "" : "s"}`;

  if (products.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${isAdmin ? 6 : 5}" class="inventory-empty">No products found.</td></tr>`;
    return;
  }

  tbody.innerHTML = "";
  products.forEach((product) => {
    const allVariants = getVariants(product);
    const visibleVariants = stockFilter === "all"
      ? allVariants
      : allVariants.filter((v) => variantMatchesStockFilter(v, stockFilter));
    const hasVariants = visibleVariants.length > 0;

    const mainRow = buildProductRow(product, hasVariants, visibleVariants);
    tbody.appendChild(mainRow);

    if (hasVariants) {
      const variantRow = buildVariantRow(visibleVariants);
      tbody.appendChild(variantRow);

      mainRow.addEventListener("click", (event) => {
        if (event.target.closest(".inventory-edit-btn")) return;
        const expanding = variantRow.hidden;

        // Accordion: collapse whichever product's variant row was
        // previously open, if any.
        if (expandedVariantRow && expandedVariantRow !== variantRow) {
          expandedVariantRow.hidden = true;
          expandedVariantMainRow.classList.remove("is-expanded");
        }

        variantRow.hidden = !expanding;
        mainRow.classList.toggle("is-expanded", expanding);
        expandedVariantRow = expanding ? variantRow : null;
        expandedVariantMainRow = expanding ? mainRow : null;
      });
    }
  });
}

// ====================================================================
// CHUNK 4B — MAIN PRODUCT ROW
// ====================================================================
function buildProductRow(product, hasVariants, variants) {
  const name = product[PRODUCT_NAME_FIELD] || "Unnamed product";
  const category = product[PRODUCT_CATEGORY_FIELD] || "—";
  const imageUrl = product[PRODUCT_IMAGE_FIELD];

  const row = document.createElement("tr");
  row.className = "inventory-row";
  if (hasVariants) row.classList.add("inventory-row--expandable");

  row.innerHTML = `
    <td><div class="inventory-product"></div></td>
    <td></td>
    <td></td>
    <td></td>
    <td></td>
  `;

  const productCell = row.querySelector(".inventory-product");

  if (hasVariants) {
    const expandIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    expandIcon.setAttribute("viewBox", "0 0 24 24");
    expandIcon.setAttribute("fill", "none");
    expandIcon.classList.add("inventory-expand-icon");
    expandIcon.setAttribute("aria-hidden", "true");
    expandIcon.innerHTML = `<path d="M9 6L15 12L9 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    productCell.appendChild(expandIcon);
  }

  const thumb = imageUrl ? document.createElement("img") : document.createElement("span");
  thumb.className = "inventory-product__thumb";
  if (imageUrl) {
    thumb.src = imageUrl;
    thumb.alt = "";
    thumb.loading = "lazy";
  } else {
    thumb.classList.add("inventory-product__thumb--empty");
  }
  productCell.appendChild(thumb);

  const nameSpan = document.createElement("span");
  nameSpan.className = "inventory-product-name";
  nameSpan.textContent = name;
  productCell.appendChild(nameSpan);

  const cells = row.querySelectorAll("td");
  cells[1].textContent = category;

  if (hasVariants) {
    cells[2].textContent = `${variants.length} variant${variants.length === 1 ? "" : "s"}`;
    cells[3].textContent = variantPriceRange(variants);
    cells[4].appendChild(buildVariantSummaryBadge(variants));
  } else {
    const stock = product[STOCK_FIELD];
    const price = product[PRODUCT_PRICE_FIELD];
    const isAvailable = product[PRODUCT_AVAILABLE_FIELD];
    cells[2].textContent = typeof stock === "number" ? stock : "—";
    cells[3].textContent = price || "—";
    cells[4].appendChild(buildStockBadge(stock, isAvailable));
  }

  if (isAdmin) {
    const actionsCell = document.createElement("td");
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "inventory-edit-btn";
    editBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M4 20L4.6 16.5L15.5 5.6C16.1 5 17 5 17.6 5.6L18.4 6.4C19 7 19 7.9 18.4 8.5L7.5 19.4L4 20Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
      </svg>
      Edit
    `;
    editBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      openEditModal(product);
    });
    actionsCell.appendChild(editBtn);
    row.appendChild(actionsCell);
  }

  return row;
}

// ====================================================================
// CHUNK 4C — VARIANT BREAKDOWN ROW
// ====================================================================
function buildVariantRow(variants) {
  const row = document.createElement("tr");
  row.className = "inventory-variant-row";
  row.hidden = true;

  const cell = document.createElement("td");
  cell.colSpan = isAdmin ? 6 : 5;

  const list = document.createElement("div");
  list.className = "variant-list";

  variants.forEach((variant) => {
    const isObject = variant && typeof variant === "object";
    const variantName = isObject ? (variant.name || variant.flavor || variant.label || "Variant") : String(variant);
    const variantStock = isObject ? variant[VARIANT_STOCK_FIELD] : undefined;
    const variantPrice = isObject ? variant[PRODUCT_PRICE_FIELD] : undefined;
    const variantAvailable = isObject ? variant[PRODUCT_AVAILABLE_FIELD] : undefined;
    const variantImage = isObject ? variant[PRODUCT_IMAGE_FIELD] : undefined;

    const item = document.createElement("div");
    item.className = "variant-list__item";
    item.innerHTML = `
      <span class="variant-list__name"></span>
      <span class="variant-list__stock"></span>
      <span class="variant-list__price"></span>
    `;

    const thumb = variantImage ? document.createElement("img") : document.createElement("span");
    thumb.className = "variant-list__thumb";
    if (variantImage) {
      thumb.src = variantImage;
      thumb.alt = "";
      thumb.loading = "lazy";
    } else {
      thumb.classList.add("variant-list__thumb--empty");
    }
    item.prepend(thumb);

    item.querySelector(".variant-list__name").textContent = variantName;
    item.querySelector(".variant-list__stock").textContent =
      typeof variantStock === "number" ? `${variantStock} in stock` : "Stock not set";
    item.querySelector(".variant-list__price").textContent = variantPrice || "—";
    item.appendChild(buildStockBadge(variantStock, variantAvailable));

    list.appendChild(item);
  });

  cell.appendChild(list);
  row.appendChild(cell);
  return row;
}

function variantPriceRange(variants) {
  const parsed = variants
    .map((v) => (v && typeof v === "object" ? v[PRODUCT_PRICE_FIELD] : null))
    .filter(Boolean)
    .map((p) => parseFloat(String(p).replace(/[^\d.]/g, "")))
    .filter((n) => !isNaN(n));

  if (parsed.length === 0) return "Varies";
  const min = Math.min(...parsed);
  const max = Math.max(...parsed);
  return min === max ? `₱${min.toFixed(2)}` : `₱${min.toFixed(2)}–₱${max.toFixed(2)}`;
}

function buildVariantSummaryBadge(variants) {
  const statuses = variants.map((v) => {
    if (!v || typeof v !== "object") return "in";
    return getStockStatus(v[VARIANT_STOCK_FIELD], v[PRODUCT_AVAILABLE_FIELD]);
  });

  const priority = ["out", "critical", "low", "unknown", "in"];
  const worst = priority.find((tier) => statuses.includes(tier)) || "in";

  const badge = document.createElement("span");
  badge.className = `stock-badge stock-badge--${worst}`;
  badge.textContent = worst === "in" ? STATUS_LABELS.in : `Some ${STATUS_LABELS[worst]}`;
  return badge;
}

function buildStockBadge(stock, isAvailable) {
  const status = getStockStatus(stock, isAvailable);
  const badge = document.createElement("span");
  badge.className = `stock-badge stock-badge--${status}`;
  badge.textContent = STATUS_LABELS[status];
  return badge;
}

// ====================================================================
// CHUNK 5 — ADMIN CONTROLS: WIRE-UP
// ====================================================================
function wireAdminControls() {
  document.getElementById("admin-toolbar").hidden = false;

  document.getElementById("add-product-btn").addEventListener("click", () => openAddModal());
  document.getElementById("product-modal-close").addEventListener("click", closeProductModal);
  document.getElementById("product-modal-cancel").addEventListener("click", closeProductModal);
  document.getElementById("product-form").addEventListener("submit", handleProductFormSubmit);
  document.getElementById("pf-image-upload-btn").addEventListener("click", () => {
    document.getElementById("pf-image-file").click();
  });
  document.getElementById("pf-image-file").addEventListener("change", handleImageFileSelected);
  document.getElementById("pf-has-variants").addEventListener("change", handleVariantModeToggle);
  document.getElementById("add-variant-btn").addEventListener("click", () => addVariantRow());
  document.getElementById("variant-editor-list").addEventListener("click", (event) => {
    const removeBtn = event.target.closest(".variant-editor__remove");
    if (removeBtn) {
      removeBtn.closest(".variant-editor__row").remove();
      return;
    }
    const imageBtn = event.target.closest(".variant-editor__image-btn");
    if (imageBtn) {
      imageBtn.closest(".variant-editor__row").querySelector(".variant-editor__image-file").click();
    }
  });
  document.getElementById("variant-editor-list").addEventListener("change", (event) => {
    if (event.target.classList.contains("variant-editor__image-file")) {
      handleVariantImageFileSelected(event.target);
    }
  });

  document.getElementById("bulk-import-btn").addEventListener("click", () => {
    document.getElementById("csv-file-input").click();
  });
  document.getElementById("csv-file-input").addEventListener("change", handleCsvFileSelected);
  document.getElementById("csv-modal-close").addEventListener("click", closeCsvModal);
  document.getElementById("csv-modal-cancel").addEventListener("click", closeCsvModal);
  document.getElementById("csv-confirm-import").addEventListener("click", handleConfirmCsvImport);
}

// ====================================================================
// CHUNK 6 — ADD / EDIT PRODUCT MODAL
// ----------------------------------------------------------------
// One modal, two modes. editingProductId is null for Add, or the
// product's doc ID for Edit (pre-fills the form). Every save — add
// or edit — goes through a native confirm() summarizing exactly
// what's about to change, per your "prevent accidental change" ask.
// ====================================================================
function openAddModal() {
  editingProductId = null;
  editOriginalProduct = null;
  document.getElementById("product-modal-title").textContent = "Add Product";
  document.getElementById("product-form-submit").textContent = "Save Product";
  document.getElementById("product-form").reset();
  document.getElementById("variant-editor-list").innerHTML = "";
  applyVariantModeUI(false);
  setImagePreview("");
  hideFormStatus();
  document.getElementById("product-modal-overlay").hidden = false;
}

function openEditModal(product) {
  editingProductId = product.id;
  editOriginalProduct = product;
  document.getElementById("product-modal-title").textContent = "Edit Product";
  document.getElementById("product-form-submit").textContent = "Save Changes";

  document.getElementById("pf-name").value = product[PRODUCT_NAME_FIELD] || "";
  document.getElementById("pf-category").value = product[PRODUCT_CATEGORY_FIELD] || "";
  document.getElementById("pf-sku").value = product.sku || "";
  document.getElementById("pf-barcode").value = product[BARCODE_FIELD] || "";
  document.getElementById("pf-unit").value = product.unit || "";
  document.getElementById("pf-principal").value = product.principal || "";
  document.getElementById("pf-wholesale").value = parsePriceNumber(product.wholesalePrice);
  setImagePreview(product[PRODUCT_IMAGE_FIELD] || "");

  const variants = getVariants(product);
  const variantList = document.getElementById("variant-editor-list");
  variantList.innerHTML = "";

  if (variants.length > 0) {
    applyVariantModeUI(true);
    variants.forEach((v) => {
      const isObject = v && typeof v === "object";
      addVariantRow({
        name: isObject ? (v.name || v.flavor || v.label || "") : String(v),
        stock: isObject && typeof v[VARIANT_STOCK_FIELD] === "number" ? v[VARIANT_STOCK_FIELD] : "",
        price: isObject ? parsePriceNumber(v[PRODUCT_PRICE_FIELD]) : "",
        imageUrl: isObject ? (v[PRODUCT_IMAGE_FIELD] || "") : "",
        barcode: isObject ? (v[BARCODE_FIELD] || "") : ""
      });
    });
  } else {
    applyVariantModeUI(false);
    document.getElementById("pf-price").value = parsePriceNumber(product[PRODUCT_PRICE_FIELD]);
    document.getElementById("pf-stock").value = typeof product[STOCK_FIELD] === "number" ? product[STOCK_FIELD] : 0;
  }

  hideFormStatus();
  document.getElementById("product-modal-overlay").hidden = false;
}

// ====================================================================
// CHUNK 6C — VARIANT MODE UI (checkbox toggle + dynamic row list)
// ====================================================================
function handleVariantModeToggle(event) {
  applyVariantModeUI(event.target.checked);
  if (event.target.checked && document.getElementById("variant-editor-list").children.length === 0) {
    addVariantRow();
  }
}

function applyVariantModeUI(isVariantMode) {
  document.getElementById("pf-has-variants").checked = isVariantMode;
  document.getElementById("simple-price-field").hidden = isVariantMode;
  document.getElementById("simple-stock-field").hidden = isVariantMode;
  document.getElementById("variant-editor-field").hidden = !isVariantMode;
  document.getElementById("pf-price").required = !isVariantMode;
  document.getElementById("pf-stock").required = !isVariantMode;
}

function addVariantRow(prefill) {
  const template = document.getElementById("variant-row-template");
  const row = template.content.firstElementChild.cloneNode(true);

  if (prefill) {
    row.querySelector(".variant-editor__name").value = prefill.name || "";
    row.querySelector(".variant-editor__stock").value = prefill.stock ?? "";
    row.querySelector(".variant-editor__price").value = prefill.price ?? "";
    row.querySelector(".variant-editor__barcode").value = prefill.barcode || "";
    if (prefill.imageUrl) {
      setVariantRowImage(row, prefill.imageUrl);
    }
  }

  document.getElementById("variant-editor-list").appendChild(row);
}

function readVariantRows() {
  return Array.from(document.querySelectorAll(".variant-editor__row")).map((row) => ({
    name: row.querySelector(".variant-editor__name").value.trim(),
    stockRaw: row.querySelector(".variant-editor__stock").value,
    priceRaw: row.querySelector(".variant-editor__price").value,
    imageUrl: row.querySelector(".variant-editor__image-url").value.trim(),
    barcode: row.querySelector(".variant-editor__barcode").value.trim()
  }));
}

// ====================================================================
// CHUNK 6D — PER-VARIANT IMAGE UPLOAD
// ----------------------------------------------------------------
// Rows are created dynamically (cloned from <template>), so their
// image button/file input are wired via event delegation on the
// list container rather than per-row listeners.
// ====================================================================
function setVariantRowImage(row, url) {
  row.querySelector(".variant-editor__image-url").value = url || "";
  const thumb = row.querySelector(".variant-editor__thumb");
  thumb.innerHTML = url
    ? `<img src="${escapeHtmlAttr(url)}" alt="">`
    : `<span class="image-preview__empty">No image</span>`;
}

async function handleVariantImageFileSelected(fileInput) {
  const row = fileInput.closest(".variant-editor__row");
  const file = fileInput.files[0];
  fileInput.value = ""; // allow re-selecting the same file later
  if (!file) return;

  const statusEl = row.querySelector(".variant-editor__image-status");
  const setStatus = (message, kind) => {
    statusEl.textContent = message;
    if (kind) statusEl.dataset.kind = kind; else delete statusEl.dataset.kind;
  };

  if (!file.type.startsWith("image/")) {
    setStatus("Please choose an image file.", "error");
    return;
  }
  if (file.size > MAX_IMAGE_SIZE_MB * 1024 * 1024) {
    setStatus(`Image is too large — max ${MAX_IMAGE_SIZE_MB}MB.`, "error");
    return;
  }

  const btn = row.querySelector(".variant-editor__image-btn");
  btn.disabled = true;
  setStatus("Uploading...", "");

  try {
    const url = await uploadImageToCloudinary(file);
    setVariantRowImage(row, url);
    setStatus("Uploaded.", "success");
  } catch (error) {
    console.error("Couldn't upload variant image:", error);
    setStatus("Upload failed. Please try again.", "error");
  } finally {
    btn.disabled = false;
  }
}

function closeProductModal() {
  document.getElementById("product-modal-overlay").hidden = true;
}

function parsePriceNumber(value) {
  const parsed = parseFloat(String(value || "").replace(/[^\d.]/g, ""));
  return isNaN(parsed) ? "" : parsed;
}

function formatPrice(numberValue) {
  return `₱${Number(numberValue).toFixed(2)}`;
}

async function handleProductFormSubmit(event) {
  event.preventDefault();
  hideFormStatus();

  const name = document.getElementById("pf-name").value.trim();
  const category = document.getElementById("pf-category").value.trim();
  const sku = document.getElementById("pf-sku").value.trim();
  const barcode = document.getElementById("pf-barcode").value.trim();
  const unit = document.getElementById("pf-unit").value.trim();
  const principal = document.getElementById("pf-principal").value.trim();
  const wholesaleInput = document.getElementById("pf-wholesale").value;
  const imageUrl = document.getElementById("pf-image").value.trim();
  const isVariantMode = document.getElementById("pf-has-variants").checked;

  if (!name || !category) {
    showFormStatus("Fill in all required fields (marked *).", "error");
    return;
  }

  const productData = {
    [PRODUCT_NAME_FIELD]: name,
    [PRODUCT_CATEGORY_FIELD]: category,
    sku: sku || null,
    [BARCODE_FIELD]: barcode || null,
    unit: unit || null,
    principal: principal || null,
    wholesalePrice: wholesaleInput !== "" ? formatPrice(Number(wholesaleInput)) : null,
    [PRODUCT_IMAGE_FIELD]: imageUrl || null
  };

  let confirmDetail;

  if (isVariantMode) {
    const rows = readVariantRows().filter((r) => r.name);

    if (rows.length === 0) {
      showFormStatus("Add at least one named variant, or uncheck \"has variants\".", "error");
      return;
    }

    const flavors = [];
    for (const row of rows) {
      const stockCount = row.stockRaw === "" ? 0 : parseInt(row.stockRaw, 10);
      const price = row.priceRaw === "" ? 0 : Number(row.priceRaw);

      if (isNaN(stockCount) || stockCount < 0 || isNaN(price) || price < 0) {
        showFormStatus(`Check the stock/price for variant "${row.name}" — must be valid, non-negative numbers.`, "error");
        return;
      }

      flavors.push({
        name: row.name,
        [VARIANT_STOCK_FIELD]: stockCount,
        [PRODUCT_PRICE_FIELD]: formatPrice(price),
        [PRODUCT_IMAGE_FIELD]: row.imageUrl || null,
        [BARCODE_FIELD]: row.barcode || null,
        [PRODUCT_AVAILABLE_FIELD]: stockCount > 0
      });
    }

    productData[PRODUCT_VARIANTS_FIELD] = flavors;
    productData[STOCK_FIELD] = null;
    productData[PRODUCT_PRICE_FIELD] = null;
    productData[PRODUCT_AVAILABLE_FIELD] = flavors.some((f) => f[PRODUCT_AVAILABLE_FIELD]);

    confirmDetail = flavors.map((f) => `  • ${f.name} — ${f[PRODUCT_PRICE_FIELD]}, stock ${f[VARIANT_STOCK_FIELD]}`).join("\n");
  } else {
    const priceInput = document.getElementById("pf-price").value;
    const stockInput = document.getElementById("pf-stock").value;

    if (priceInput === "" || stockInput === "") {
      showFormStatus("Fill in all required fields (marked *).", "error");
      return;
    }

    const price = Number(priceInput);
    const stockCount = parseInt(stockInput, 10);

    if (isNaN(price) || price < 0 || isNaN(stockCount) || stockCount < 0) {
      showFormStatus("Price and stock must be valid, non-negative numbers.", "error");
      return;
    }

    productData[PRODUCT_PRICE_FIELD] = formatPrice(price);
    productData[STOCK_FIELD] = stockCount;
    productData[PRODUCT_AVAILABLE_FIELD] = stockCount > 0;
    productData[PRODUCT_VARIANTS_FIELD] = [];

    confirmDetail = `Price: ${formatPrice(price)}\nStock: ${stockCount}`;
  }

  const isEditing = editingProductId !== null;

  // ---- Confirmation step (prevents accidental saves) ----------------
  const confirmBody = isEditing
    ? confirmDetail
    : `Category: ${category}\n${confirmDetail}`;

  const confirmed = await confirmDialog(confirmBody, {
    title: isEditing ? `Save changes to "${name}"?` : `Add new product "${name}"?`,
    confirmLabel: isEditing ? "Save Changes" : "Add Product"
  });

  if (!confirmed) return;

  const submitBtn = document.getElementById("product-form-submit");
  submitBtn.disabled = true;
  submitBtn.textContent = "Saving...";

  try {
    if (isEditing) {
      await updateDoc(doc(db, PRODUCTS_COLLECTION, editingProductId), productData);
      logManualStockChanges(editOriginalProduct, productData, name, editingProductId);
    } else {
      productData.createdAt = serverTimestamp();
      await addDoc(collection(db, PRODUCTS_COLLECTION), productData);
    }

    await reloadAfterWrite();
    closeProductModal();
  } catch (error) {
    console.error("Couldn't save product:", error);
    showFormStatus("Something went wrong saving this product. Please try again.", "error");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = isEditing ? "Save Changes" : "Save Product";
  }
}

function showFormStatus(message, kind) {
  const el = document.getElementById("product-form-status");
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
}

function hideFormStatus() {
  document.getElementById("product-form-status").hidden = true;
}

// ====================================================================
// CHUNK 6B — IMAGE UPLOAD (Cloudinary, unsigned)
// ----------------------------------------------------------------
// Uploads straight from the browser to Cloudinary using an unsigned
// preset — no server, no secret key exposed. The hidden #pf-image
// field holds the resulting secure_url, which is what actually gets
// saved to Firestore's imageUrl field on submit.
// ====================================================================
function setImagePreview(url) {
  document.getElementById("pf-image").value = url || "";
  const preview = document.getElementById("pf-image-preview");
  setUploadStatus("", null);

  if (url) {
    preview.innerHTML = `<img src="${escapeHtmlAttr(url)}" alt="">`;
  } else {
    preview.innerHTML = `<span class="image-preview__empty">No image</span>`;
  }
}

// Minimal escaping since this URL either comes from Cloudinary's own
// response or an existing Firestore value — not free-text user input,
// but cheap insurance against a malformed URL breaking the attribute.
function escapeHtmlAttr(value) {
  return value.replace(/"/g, "&quot;");
}

async function handleImageFileSelected(event) {
  const file = event.target.files[0];
  event.target.value = ""; // allow re-selecting the same file later
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    setUploadStatus("Please choose an image file.", "error");
    return;
  }
  if (file.size > MAX_IMAGE_SIZE_MB * 1024 * 1024) {
    setUploadStatus(`Image is too large — max ${MAX_IMAGE_SIZE_MB}MB.`, "error");
    return;
  }

  const uploadBtn = document.getElementById("pf-image-upload-btn");
  uploadBtn.disabled = true;
  setUploadStatus("Uploading...", "");

  try {
    const url = await uploadImageToCloudinary(file);
    setImagePreview(url);
    setUploadStatus("Uploaded.", "success");
  } catch (error) {
    console.error("Couldn't upload image:", error);
    setUploadStatus("Upload failed. Please try again.", "error");
  } finally {
    uploadBtn.disabled = false;
  }
}

async function uploadImageToCloudinary(file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  formData.append("folder", CLOUDINARY_FOLDER);

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
    { method: "POST", body: formData }
  );

  if (!response.ok) {
    throw new Error(`Cloudinary upload failed with status ${response.status}`);
  }

  const data = await response.json();
  return data.secure_url;
}

function setUploadStatus(message, kind) {
  const el = document.getElementById("pf-image-upload-status");
  el.textContent = message;
  if (kind) {
    el.dataset.kind = kind;
  } else {
    delete el.dataset.kind;
  }
}

// ====================================================================
// CHUNK 7 — BULK CSV IMPORT
// ----------------------------------------------------------------
// Parses via PapaParse (loaded globally in Inventory.html — not an
// ES module import), maps columns per CSV_COLUMN_MAP, shows a
// preview table, and only writes to Firestore after an explicit
// "Confirm Import" click. Writes are batched (max 450 per batch,
// under Firestore's 500-op limit) since a CSV could have many rows.
// ====================================================================
// The exact column set the CSV must have to be accepted at all —
// matches CSV_COLUMN_MAP's keys. If any of these are missing from
// the uploaded file's header row, the import is rejected outright
// with a warning, before any row data is even looked at.
const EXPECTED_CSV_HEADERS = Object.keys(CSV_COLUMN_MAP);

function findMissingHeaders(actualFields) {
  const normalizedActual = (actualFields || []).map((h) => h.trim().toLowerCase());
  return EXPECTED_CSV_HEADERS.filter((expected) => !normalizedActual.includes(expected));
}

function handleCsvFileSelected(event) {
  const file = event.target.files[0];
  event.target.value = ""; // allow re-selecting the same file later
  if (!file) return;

  window.Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: (results) => {
      document.getElementById("csv-modal-overlay").hidden = false;

      const missingHeaders = findMissingHeaders(results.meta.fields);
      if (missingHeaders.length > 0) {
        showCsvHeaderError(missingHeaders);
        return;
      }

      hideCsvStatus();
      parsedCsvRows = results.data.map(csvRowToProduct);
      renderCsvPreview();
    },
    error: (error) => {
      console.error("Couldn't parse CSV:", error);
      window.alert("Couldn't read that CSV file. Please check the format and try again.");
    }
  });
}

// Rejects the file entirely — no preview, no row data, Confirm Import
// stays disabled — until a CSV with the correct headers is uploaded.
function showCsvHeaderError(missingHeaders) {
  parsedCsvRows = [];
  document.getElementById("csv-preview-tbody").innerHTML = "";
  document.getElementById("csv-summary").textContent = "";
  document.getElementById("csv-confirm-import").disabled = true;

  const el = document.getElementById("csv-status");
  el.textContent = `Please upload the correct CSV. Missing column${missingHeaders.length === 1 ? "" : "s"}: ${missingHeaders.join(", ")}`;
  el.dataset.kind = "error";
  el.hidden = false;
}

function hideCsvStatus() {
  document.getElementById("csv-status").hidden = true;
}

function csvRowToProduct(rawRow) {
  const normalized = {};
  Object.keys(rawRow).forEach((key) => {
    const cleanKey = key.trim().toLowerCase();
    normalized[cleanKey] = (rawRow[key] || "").toString().trim();
  });

  const get = (csvHeader) => normalized[csvHeader] || "";

  const stockCount = parseInt(get("qty"), 10);
  const qty1 = get("qty 1") ? parseInt(get("qty 1"), 10) : null;
  const qty2 = get("qty 2") ? parseInt(get("qty 2"), 10) : null;
  const priceNum = parseFloat(get("unit_price").replace(/[^\d.]/g, ""));
  const wsNum = parseFloat(get("unit_ws").replace(/[^\d.]/g, ""));

  const name = get("description");
  const category = get("category");

  return {
    [PRODUCT_NAME_FIELD]: name,
    [PRODUCT_CATEGORY_FIELD]: category,
    sku: get("sku") || null,
    principal: get("principal") || null,
    unit: get("unit") || null,
    [STOCK_FIELD]: isNaN(stockCount) ? 0 : stockCount,
    qty1: isNaN(qty1) ? null : qty1,
    qty2: isNaN(qty2) ? null : qty2,
    [PRODUCT_PRICE_FIELD]: isNaN(priceNum) ? "₱0.00" : formatPrice(priceNum),
    wholesalePrice: isNaN(wsNum) ? null : formatPrice(wsNum),
    [PRODUCT_AVAILABLE_FIELD]: true,
    _valid: Boolean(name) && Boolean(category)
  };
}

function renderCsvPreview() {
  const tbody = document.getElementById("csv-preview-tbody");
  const summary = document.getElementById("csv-summary");
  const confirmBtn = document.getElementById("csv-confirm-import");

  const validCount = parsedCsvRows.filter((r) => r._valid).length;
  const invalidCount = parsedCsvRows.length - validCount;

  summary.textContent = invalidCount > 0
    ? `${validCount} valid, ${invalidCount} skipped (missing name or category)`
    : `${validCount} product${validCount === 1 ? "" : "s"} ready to import`;

  confirmBtn.disabled = validCount === 0;

  tbody.innerHTML = "";
  parsedCsvRows.forEach((row) => {
    const tr = document.createElement("tr");
    if (!row._valid) tr.style.opacity = "0.45";
    tr.innerHTML = `
      <td></td><td></td><td></td><td></td><td></td>
    `;
    const cells = tr.querySelectorAll("td");
    cells[0].textContent = row[PRODUCT_NAME_FIELD] || "(missing name)";
    cells[1].textContent = row[PRODUCT_CATEGORY_FIELD] || "(missing category)";
    cells[2].textContent = row[STOCK_FIELD];
    cells[3].textContent = row[PRODUCT_PRICE_FIELD];
    cells[4].textContent = row.sku || "—";
    tbody.appendChild(tr);
  });
}

function closeCsvModal() {
  document.getElementById("csv-modal-overlay").hidden = true;
  hideCsvStatus();
  parsedCsvRows = [];
}

async function handleConfirmCsvImport() {
  const validRows = parsedCsvRows.filter((r) => r._valid);
  if (validRows.length === 0) return;

  const confirmed = await confirmDialog(
    "This can't be undone automatically once imported.",
    {
      title: `Import ${validRows.length} product${validRows.length === 1 ? "" : "s"}?`,
      confirmLabel: "Confirm Import"
    }
  );
  if (!confirmed) return;

  const confirmBtn = document.getElementById("csv-confirm-import");
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Importing...";

  try {
    const BATCH_LIMIT = 450; // stay safely under Firestore's 500-op batch cap
    for (let i = 0; i < validRows.length; i += BATCH_LIMIT) {
      const chunk = validRows.slice(i, i + BATCH_LIMIT);
      const batch = writeBatch(db);
      chunk.forEach((row) => {
        const { _valid, ...productData } = row;
        productData.createdAt = serverTimestamp();
        const newDocRef = doc(collection(db, PRODUCTS_COLLECTION));
        batch.set(newDocRef, productData);
      });
      await batch.commit();
    }

    await reloadAfterWrite();
    closeCsvModal();
  } catch (error) {
    console.error("Couldn't import CSV:", error);
    window.alert("Something went wrong during import. Some products may not have been added — check your inventory list.");
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Confirm Import";
  }
}

// ====================================================================
// CHUNK 8 — BARCODE SCANNER (both roles)
// ----------------------------------------------------------------
// A USB/Bluetooth barcode scanner works as a "keyboard emulator" — it
// just types the barcode digits into whatever input is focused, then
// sends Enter. No special API needed; this just listens for Enter on
// a plain text input.
//
// Two modes:
//   "sale"  — deducts a quantity (e.g. a customer bought 2). Fails if
//             there isn't enough stock.
//   "count" — sets the exact stock number directly (a physical count
//             / stock-take correction). No validation against the
//             old value — it's an overwrite by design.
//
// Both go through a Firestore transaction (runTransaction), same
// pattern your mobile app's own checkout uses — reads the current
// value, computes the new one, and writes it atomically, so two
// people scanning at once can't silently clobber each other. For a
// variant, the matching flavor entry is re-located BY BARCODE inside
// the transaction (not by a cached array index), so it can't target
// the wrong entry even if the array changed since the page loaded.
// ====================================================================
let scannerMode = "sale";
let scannerCurrentMatch = null; // { product, barcode, info }

function wireScanner() {
  document.getElementById("scan-barcode-btn").addEventListener("click", openScannerModal);
  document.getElementById("scanner-modal-close").addEventListener("click", closeScannerModal);
  document.getElementById("scanner-modal-done").addEventListener("click", closeScannerModal);

  document.querySelectorAll("#scanner-mode-toggle .tab-row__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      scannerMode = btn.dataset.mode;
      document.querySelectorAll("#scanner-mode-toggle .tab-row__btn").forEach((b) =>
        b.classList.toggle("is-active", b === btn)
      );
      updateScannerActionUI();
    });
  });

  const barcodeInput = document.getElementById("scanner-barcode-input");
  barcodeInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const value = barcodeInput.value.trim();
    barcodeInput.value = "";
    handleBarcodeScanned(value);
  });

  document.getElementById("scanner-action-btn").addEventListener("click", handleScannerAction);
}

function openScannerModal() {
  scannerMode = "sale";
  scannerCurrentMatch = null;
  document.querySelectorAll("#scanner-mode-toggle .tab-row__btn").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.mode === "sale")
  );
  document.getElementById("scanner-found").hidden = true;
  hideScannerStatus();
  document.getElementById("scanner-log").innerHTML =
    `<p class="scanner-log__empty">Scanned items will appear here.</p>`;

  document.getElementById("scanner-modal-overlay").hidden = false;
  const input = document.getElementById("scanner-barcode-input");
  input.value = "";
  input.focus();
}

function closeScannerModal() {
  document.getElementById("scanner-modal-overlay").hidden = true;
  // Refresh the main table — scans done in this session may have
  // changed stock the visible rows/badges should now reflect.
  applyFiltersAndRender();
}

// ---- Lookup (uses the already-cached product list — instant, no
// network round-trip; the actual write below re-verifies fresh) -----
function findProductByBarcode(barcode) {
  for (const product of allProducts) {
    if (product[BARCODE_FIELD] === barcode) return product;
    const variants = getVariants(product);
    if (variants.some((v) => v && typeof v === "object" && v[BARCODE_FIELD] === barcode)) {
      return product;
    }
  }
  return null;
}

function getMatchDisplayInfo(product, barcode) {
  if (product[BARCODE_FIELD] === barcode) {
    return {
      name: product[PRODUCT_NAME_FIELD] || "Unnamed product",
      stock: typeof product[STOCK_FIELD] === "number" ? product[STOCK_FIELD] : null,
      imageUrl: product[PRODUCT_IMAGE_FIELD]
    };
  }

  const variants = getVariants(product);
  const variant = variants.find((v) => v && typeof v === "object" && v[BARCODE_FIELD] === barcode);
  return {
    name: `${product[PRODUCT_NAME_FIELD] || "Product"} — ${variant?.name || "Variant"}`,
    stock: typeof variant?.[VARIANT_STOCK_FIELD] === "number" ? variant[VARIANT_STOCK_FIELD] : null,
    imageUrl: variant?.[PRODUCT_IMAGE_FIELD] || product[PRODUCT_IMAGE_FIELD]
  };
}

function handleBarcodeScanned(barcode) {
  hideScannerStatus();
  if (!barcode) return;

  // Sale mode: scanning the SAME item again before clicking "Record
  // Sale" just bumps the quantity by 1, instead of resetting back to
  // 1 — matches how a real cashier scans the same product multiple
  // times in a row rather than typing a number. Doesn't apply in
  // Stock Count mode, since that's meant to be an exact count, not
  // an incrementing tally.
  if (scannerMode === "sale" && scannerCurrentMatch && scannerCurrentMatch.barcode === barcode) {
    const qtyInput = document.getElementById("scanner-qty-input");
    qtyInput.value = (parseInt(qtyInput.value, 10) || 0) + 1;
    return;
  }

  const product = findProductByBarcode(barcode);
  if (!product) {
    scannerCurrentMatch = null;
    document.getElementById("scanner-found").hidden = true;
    showScannerStatus(`No product found for barcode "${barcode}".`, "error");
    return;
  }

  const info = getMatchDisplayInfo(product, barcode);
  scannerCurrentMatch = { product, barcode, info };

  document.getElementById("scanner-found-name").textContent = info.name;
  document.getElementById("scanner-found-thumb").src = info.imageUrl || "";
  document.getElementById("scanner-found").hidden = false;
  updateScannerActionUI();
}

function updateScannerActionUI() {
  if (!scannerCurrentMatch) return;

  const actionBtn = document.getElementById("scanner-action-btn");
  const qtyInput = document.getElementById("scanner-qty-input");
  const stockLabel = document.getElementById("scanner-found-current-stock");
  const stock = scannerCurrentMatch.info.stock;

  stockLabel.textContent = typeof stock === "number" ? `Current stock: ${stock}` : "Current stock: not set";

  if (scannerMode === "sale") {
    actionBtn.textContent = "Record Sale";
    qtyInput.min = 1;
    qtyInput.value = 1;
  } else {
    actionBtn.textContent = "Update Count";
    qtyInput.min = 0;
    qtyInput.value = typeof stock === "number" ? stock : 0;
  }
}

async function handleScannerAction() {
  if (!scannerCurrentMatch) return;

  const qtyInput = document.getElementById("scanner-qty-input");
  const value = parseInt(qtyInput.value, 10);

  if (isNaN(value) || value < 0) {
    showScannerStatus("Enter a valid number.", "error");
    return;
  }

  const actionBtn = document.getElementById("scanner-action-btn");
  actionBtn.disabled = true;
  actionBtn.textContent = "Saving...";

  try {
    const result = await performScanAction(
      scannerCurrentMatch.product.id,
      scannerCurrentMatch.barcode,
      scannerMode,
      value
    );

    patchLocalProductStock(scannerCurrentMatch.product.id, scannerCurrentMatch.barcode, result.newStock);
    invalidateProductsCache();
    addScanLogEntry(result.name, scannerMode, value, result.newStock);
    showScannerStatus(`Done — ${result.name} now at ${result.newStock}.`, "success");

    logStockMovement({
      productId: result.productId,
      productName: result.productName,
      variantName: result.variantName,
      type: scannerMode === "sale" ? "sale" : "count",
      previousStock: result.previousStock,
      newStock: result.newStock
    });

    scannerCurrentMatch = null;
    document.getElementById("scanner-found").hidden = true;
  } catch (error) {
    console.error("Scan action failed:", error);
    showScannerStatus(error.message || "Something went wrong.", "error");
  } finally {
    actionBtn.disabled = false;
    actionBtn.textContent = scannerMode === "sale" ? "Record Sale" : "Update Count";
    document.getElementById("scanner-barcode-input").focus();
  }
}

// The actual write — re-verifies everything fresh inside the
// transaction rather than trusting cached data or a cached array index.
async function performScanAction(productId, barcode, mode, value) {
  const productRef = doc(db, PRODUCTS_COLLECTION, productId);

  return runTransaction(db, async (transaction) => {
    const snap = await transaction.get(productRef);
    if (!snap.exists()) throw new Error("This product no longer exists.");
    const data = snap.data();

    // Parent-level barcode match
    if (data[BARCODE_FIELD] === barcode) {
      const currentStock = typeof data[STOCK_FIELD] === "number" ? data[STOCK_FIELD] : 0;
      const newStock = computeNewStock(currentStock, mode, value);
      transaction.update(productRef, {
        [STOCK_FIELD]: newStock,
        [PRODUCT_AVAILABLE_FIELD]: newStock > 0
      });
      return {
        newStock,
        previousStock: currentStock,
        name: data[PRODUCT_NAME_FIELD] || "Product",
        productId,
        productName: data[PRODUCT_NAME_FIELD] || "Product",
        variantName: null
      };
    }

    // Otherwise it must be a variant — re-locate it by barcode in the
    // freshly-read array, not by a cached index.
    const variants = Array.isArray(data[PRODUCT_VARIANTS_FIELD]) ? [...data[PRODUCT_VARIANTS_FIELD]] : [];
    const idx = variants.findIndex((v) => v && typeof v === "object" && v[BARCODE_FIELD] === barcode);
    if (idx === -1) throw new Error("This barcode is no longer on this product.");

    const variant = variants[idx];
    const currentStock = typeof variant[VARIANT_STOCK_FIELD] === "number" ? variant[VARIANT_STOCK_FIELD] : 0;
    const newStock = computeNewStock(currentStock, mode, value);

    variants[idx] = { ...variant, [VARIANT_STOCK_FIELD]: newStock, [PRODUCT_AVAILABLE_FIELD]: newStock > 0 };
    transaction.update(productRef, { [PRODUCT_VARIANTS_FIELD]: variants });

    return {
      newStock,
      previousStock: currentStock,
      name: `${data[PRODUCT_NAME_FIELD] || "Product"} — ${variant.name || "Variant"}`,
      productId,
      productName: data[PRODUCT_NAME_FIELD] || "Product",
      variantName: variant.name || "Variant"
    };
  });
}

function computeNewStock(currentStock, mode, value) {
  if (mode === "sale") {
    if (currentStock < value) throw new Error(`Only ${currentStock} left — can't deduct ${value}.`);
    return currentStock - value;
  }
  return value; // "count" mode — direct overwrite
}

// Patches the in-memory cache so subsequent scans in this same
// session see the fresh number without a network round-trip. The
// sessionStorage cache is separately invalidated so other pages get
// a real fetch next time, rather than serving this now-stale copy.
function patchLocalProductStock(productId, barcode, newStock) {
  const product = allProducts.find((p) => p.id === productId);
  if (!product) return;

  if (product[BARCODE_FIELD] === barcode) {
    product[STOCK_FIELD] = newStock;
    product[PRODUCT_AVAILABLE_FIELD] = newStock > 0;
    return;
  }

  const variants = getVariants(product);
  const variant = variants.find((v) => v && typeof v === "object" && v[BARCODE_FIELD] === barcode);
  if (variant) {
    variant[VARIANT_STOCK_FIELD] = newStock;
    variant[PRODUCT_AVAILABLE_FIELD] = newStock > 0;
  }
}

function addScanLogEntry(name, mode, value, newStock) {
  const log = document.getElementById("scanner-log");
  const empty = log.querySelector(".scanner-log__empty");
  if (empty) empty.remove();

  const time = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const detail = mode === "sale" ? `−${value} → ${newStock} left` : `set to ${newStock}`;

  const item = document.createElement("div");
  item.className = "scanner-log__item";
  item.innerHTML = `
    <span class="scanner-log__item-name"></span>
    <span class="scanner-log__item-detail"></span>
  `;
  item.querySelector(".scanner-log__item-name").textContent = name;
  item.querySelector(".scanner-log__item-detail").textContent = `${detail} · ${time}`;
  log.prepend(item);
}

function showScannerStatus(message, kind) {
  const el = document.getElementById("scanner-status");
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
}

function hideScannerStatus() {
  document.getElementById("scanner-status").hidden = true;
}

// ====================================================================
// CHUNK 9 — STOCK MOVEMENT LOG (both roles)
// ----------------------------------------------------------------
// Deliberately lightweight — this is NOT a sales/POS/receipt system.
// It's an append-only audit trail answering "why did this stock
// number change" for scanner actions and manual Add/Edit Product
// stock edits. Nothing here handles pricing breakdowns, payment, or
// anything resembling a receipt — that was a conscious scope decision
// to stay within Inventory Management rather than building a
// separate point-of-sale feature.
// ====================================================================
// Compares the pre-edit product against what was just saved, logging
// one entry per value that actually changed — parent stock, and/or
// any individual variant whose stock differs from before. Unchanged
// values (e.g. only the price or category was edited) log nothing.
function logManualStockChanges(oldProduct, newProductData, productName, productId) {
  if (!oldProduct) return;

  const oldVariants = getVariants(oldProduct);
  const newVariants = Array.isArray(newProductData[PRODUCT_VARIANTS_FIELD]) ? newProductData[PRODUCT_VARIANTS_FIELD] : [];

  if (newVariants.length === 0 && oldVariants.length === 0) {
    const oldStock = typeof oldProduct[STOCK_FIELD] === "number" ? oldProduct[STOCK_FIELD] : null;
    const newStock = typeof newProductData[STOCK_FIELD] === "number" ? newProductData[STOCK_FIELD] : null;
    if (oldStock !== null && newStock !== null && oldStock !== newStock) {
      logStockMovement({ productId, productName, variantName: null, type: "manual_edit", previousStock: oldStock, newStock });
    }
    return;
  }

  // Variant mode: match old vs new variants by name (barcode may not
  // be set on older entries, name is the more reliable common key).
  newVariants.forEach((newVariant) => {
    const oldVariant = oldVariants.find((v) => v && typeof v === "object" && v.name === newVariant.name);
    const oldStock = oldVariant && typeof oldVariant[VARIANT_STOCK_FIELD] === "number" ? oldVariant[VARIANT_STOCK_FIELD] : null;
    const newStock = typeof newVariant[VARIANT_STOCK_FIELD] === "number" ? newVariant[VARIANT_STOCK_FIELD] : null;
    if (oldStock !== null && newStock !== null && oldStock !== newStock) {
      logStockMovement({
        productId, productName,
        variantName: newVariant.name,
        type: "manual_edit",
        previousStock: oldStock,
        newStock
      });
    }
  });
}

function logStockMovement({ productId, productName, variantName, type, previousStock, newStock }) {
  // Fire-and-forget on purpose — a failed log write shouldn't block
  // or roll back the actual stock change, which already succeeded.
  addDoc(collection(db, STOCK_MOVEMENTS_COLLECTION), {
    productId,
    productName,
    variantName: variantName || null,
    type,
    previousStock,
    newStock,
    performedByEmail: currentUser?.email || "unknown",
    performedByRole: currentUserRole,
    createdAt: serverTimestamp()
  }).catch((error) => {
    console.error("Couldn't write stock movement log entry:", error);
  });
}

function wireStockLog() {
  document.getElementById("stock-log-btn").addEventListener("click", openStockLogModal);
  document.getElementById("stock-log-modal-close").addEventListener("click", closeStockLogModal);
  document.getElementById("stock-log-modal-done").addEventListener("click", closeStockLogModal);
}

async function openStockLogModal() {
  document.getElementById("stock-log-modal-overlay").hidden = false;
  const list = document.getElementById("stock-log-list");
  list.innerHTML = `<p class="scanner-log__empty">Loading...</p>`;

  try {
    const logQuery = query(
      collection(db, STOCK_MOVEMENTS_COLLECTION),
      orderBy("createdAt", "desc"),
      limit(100)
    );
    const snap = await getDocs(logQuery);

    if (snap.empty) {
      list.innerHTML = `<p class="scanner-log__empty">No stock changes recorded yet.</p>`;
      return;
    }

    list.innerHTML = "";
    snap.forEach((docSnap) => list.appendChild(buildStockLogItem(docSnap.data())));
  } catch (error) {
    console.error("Couldn't load stock log:", error);
    list.innerHTML = `<p class="scanner-log__empty">Couldn't load the stock log right now.</p>`;
  }
}

function closeStockLogModal() {
  document.getElementById("stock-log-modal-overlay").hidden = true;
}

const MOVEMENT_TYPE_LABELS = {
  sale: "Sale",
  count: "Stock Count",
  manual_edit: "Manual Edit"
};

function buildStockLogItem(entry) {
  const el = document.createElement("div");
  el.className = "stock-log__item";

  const badge = document.createElement("span");
  badge.className = `stock-log__type-badge stock-log__type-badge--${entry.type}`;
  badge.textContent = MOVEMENT_TYPE_LABELS[entry.type] || entry.type;
  el.appendChild(badge);

  const name = document.createElement("span");
  name.className = "stock-log__item-name";
  name.textContent = entry.variantName
    ? `${entry.productName} — ${entry.variantName}`
    : entry.productName;
  el.appendChild(name);

  const change = document.createElement("span");
  const delta = entry.newStock - entry.previousStock;
  change.className = `stock-log__item-change stock-log__item-change--${delta < 0 ? "down" : delta > 0 ? "up" : "same"}`;
  change.textContent = `${entry.previousStock} → ${entry.newStock}`;
  el.appendChild(change);

  const meta = document.createElement("span");
  meta.className = "stock-log__item-meta";
  const timeLabel = entry.createdAt?.toDate
    ? entry.createdAt.toDate().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "";
  meta.textContent = `${entry.performedByEmail || "unknown"} · ${timeLabel}`;
  el.appendChild(meta);

  return el;
}