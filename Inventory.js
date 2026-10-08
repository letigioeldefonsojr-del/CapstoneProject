import { db } from "./firebase-config.js";
import {
  collection, addDoc, updateDoc, doc, writeBatch, serverTimestamp, runTransaction,
  getDocs, query, orderBy, limit, deleteField, Timestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getProducts, invalidateProductsCache } from "./ProductCache.js";
import { confirmDialog } from "./ConfirmDialog.js";
import { promptPasswordConfirm } from "./PasswordConfirm.js";
import { fuzzyMatch } from "./FuzzySearch.js";
import { sendPromotionPushes } from "./PromotionPush.js";

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
// How this product is sold — distinct from the free-text "unit" field
// (which stays as-is, e.g. "pcs", "box"). Lives on the parent product,
// not per-variant, since a product's packaging type is normally the
// same across all its flavors.
const PRODUCT_SELLING_TYPE_FIELD = "sellingType";
const SELLING_TYPE_LABELS = { ream: "Ream", bulk: "Bulk", piece: "Piece" };
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
let selectedProductIds = new Set(); // bulk-delete selection (admin only)
let editingProductId = null; // null = Add mode, a product id = Edit mode
let parsedCsvRows = [];      // rows staged for the CSV preview/confirm step
let rawCsvRows = [];         // unmapped rows from Papa Parse — re-mapped whenever the ignore-qty checkbox changes

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
  document.getElementById("scanner-add-new-btn")?.setAttribute("hidden", "");
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
  rawCsvRows = [];
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
    const name = product[PRODUCT_NAME_FIELD] || "";
    const matchesSearch = fuzzyMatch(term, name);
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
  document.getElementById("select-all-header").hidden = !isAdmin;
  expandedVariantRow = null;
  expandedVariantMainRow = null;

  // Selection resets on every re-render (filter/search/sort change) —
  // safer than silently keeping a selection the user can no longer see.
  selectedProductIds.clear();
  updateBulkDeleteBar();
  const selectAllCheckbox = document.getElementById("select-all-checkbox");
  if (selectAllCheckbox) selectAllCheckbox.checked = false;

  countLabel.textContent = `${products.length} product${products.length === 1 ? "" : "s"}`;

  if (products.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${isAdmin ? 9 : 7}" class="inventory-empty">No products found.</td></tr>`;
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
      const variantRow = buildVariantRow(visibleVariants, product);
      tbody.appendChild(variantRow);

      mainRow.addEventListener("click", (event) => {
        if (event.target.closest(".inventory-edit-btn, .inventory-row-checkbox")) return;
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
// Featured star: admins click it to feature/unfeature a product. Writes
// `featured` (boolean) + `featuredAt` (server time) on the product doc;
// the mobile app reads those. Non-admins just see the star if featured.
function buildFeaturedStar(product) {
  const star = document.createElement("button");
  star.type = "button";
  star.className = "featured-star";
  const paint = () => {
    const on = product.featured === true;
    star.classList.toggle("featured-star--on", on);
    star.textContent = on ? "★" : "☆";
    star.title = on ? "Featured — click to remove" : "Click to feature this product in the app";
    star.setAttribute("aria-label", star.title);
    star.setAttribute("aria-pressed", String(on));
  };
  paint();

  if (!isAdmin) {
    star.disabled = true;
    star.hidden = product.featured !== true;
    return star;
  }

  star.addEventListener("click", async (event) => {
    event.stopPropagation();
    const next = product.featured !== true;
    star.disabled = true;
    try {
      await updateDoc(doc(db, PRODUCTS_COLLECTION, product.id), {
        featured: next,
        featuredAt: next ? serverTimestamp() : null
      });
      product.featured = next;
      invalidateProductsCache();
      paint();
    } catch (error) {
      console.error("Couldn't update featured:", error);
      alert("Couldn't update the featured status. Please try again.");
    } finally {
      star.disabled = false;
    }
  });
  return star;
}

function buildProductRow(product, hasVariants, variants) {
  const name = product[PRODUCT_NAME_FIELD] || "Unnamed product";
  const category = product[PRODUCT_CATEGORY_FIELD] || "—";
  const imageUrl = product[PRODUCT_IMAGE_FIELD];

  const row = document.createElement("tr");
  row.className = "inventory-row";
  if (hasVariants) row.classList.add("inventory-row--expandable");

  const checkboxCellHtml = isAdmin
    ? `<td><input type="checkbox" class="inventory-row-checkbox" aria-label="Select ${escapeHtmlAttr(name)}"></td>`
    : "";

  row.innerHTML = `
    ${checkboxCellHtml}
    <td><div class="inventory-product"></div></td>
    <td></td>
    <td></td>
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
  productCell.appendChild(buildFeaturedStar(product));

  const cells = row.querySelectorAll("td");
  const offset = isAdmin ? 1 : 0;
  cells[1 + offset].textContent = category;
  cells[2 + offset].appendChild(buildSellingTypeBadge(product[PRODUCT_SELLING_TYPE_FIELD]));

  if (hasVariants) {
    cells[3 + offset].textContent = `${variants.length} variant${variants.length === 1 ? "" : "s"}`;
    renderRetailVariantRange(cells[4 + offset], variants, product);
    cells[5 + offset].textContent = variantWholesaleRange(variants);
    cells[6 + offset].appendChild(buildVariantSummaryBadge(variants));
  } else {
    const stock = product[STOCK_FIELD];
    const price = product[PRODUCT_PRICE_FIELD];
    const isAvailable = product[PRODUCT_AVAILABLE_FIELD];
    cells[3 + offset].textContent = typeof stock === "number" ? stock : "—";
    renderRetailPrice(cells[4 + offset], price, product);
    cells[5 + offset].textContent = product.wholesalePrice || "—";
    cells[6 + offset].appendChild(buildStockBadge(stock, isAvailable));
  }

  if (isAdmin) {
    const checkbox = row.querySelector(".inventory-row-checkbox");
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedProductIds.add(product.id);
      else selectedProductIds.delete(product.id);
      updateBulkDeleteBar();
    });

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
function buildVariantRow(variants, product) {
  const row = document.createElement("tr");
  row.className = "inventory-variant-row";
  row.hidden = true;

  const cell = document.createElement("td");
  cell.colSpan = isAdmin ? 9 : 7;

  const list = document.createElement("div");
  list.className = "variant-list";

  variants.forEach((variant) => {
    const isObject = variant && typeof variant === "object";
    const variantName = isObject ? (variant.name || variant.flavor || variant.label || "Variant") : String(variant);
    const variantStock = isObject ? variant[VARIANT_STOCK_FIELD] : undefined;
    const variantPrice = isObject ? variant[PRODUCT_PRICE_FIELD] : undefined;
    const variantWholesale = isObject ? variant.wholesalePrice : undefined;
    const variantAvailable = isObject ? variant[PRODUCT_AVAILABLE_FIELD] : undefined;
    const variantImage = isObject ? variant[PRODUCT_IMAGE_FIELD] : undefined;

    const item = document.createElement("div");
    item.className = "variant-list__item";
    item.innerHTML = `
      <span class="variant-list__name"></span>
      <span class="variant-list__stock"></span>
      <span class="variant-list__price"></span>
      <span class="variant-list__wholesale"></span>
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
    renderVariantRetail(item.querySelector(".variant-list__price"), variantPrice, product);
    item.querySelector(".variant-list__wholesale").textContent = `Wholesale ${variantWholesale || "—"}`;
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

function normalizeSellingType(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return SELLING_TYPE_LABELS[value] ? value : null;
}

function buildSellingTypeBadge(sellingType) {
  const badge = document.createElement("span");
  if (!sellingType) {
    badge.className = "type-badge type-badge--unknown";
    badge.textContent = "—";
    return badge;
  }
  badge.className = `type-badge type-badge--${sellingType}`;
  badge.textContent = SELLING_TYPE_LABELS[sellingType] || sellingType;
  return badge;
}

function variantWholesaleRange(variants) {
  const parsed = variants
    .map((v) => (v && typeof v === "object" ? v.wholesalePrice : null))
    .filter(Boolean)
    .map((p) => parseFloat(String(p).replace(/[^\d.]/g, "")))
    .filter((n) => !isNaN(n));

  if (parsed.length === 0) return "—";
  const min = Math.min(...parsed);
  const max = Math.max(...parsed);
  return min === max ? `₱${min.toFixed(2)}` : `₱${min.toFixed(2)}–₱${max.toFixed(2)}`;
}

// ====================================================================
// CHUNK 5 — ADMIN CONTROLS: WIRE-UP
// ====================================================================
function wireAdminControls() {
  document.getElementById("admin-toolbar").hidden = false;

  document.getElementById("select-all-checkbox").addEventListener("change", handleSelectAllToggle);
  document.getElementById("bulk-delete-btn").addEventListener("click", handleBulkDelete);

  wireDiscountControls();

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
  document.getElementById("csv-ignore-qty").addEventListener("change", () => {
    if (rawCsvRows.length > 0) remapAndRenderCsvPreview();
  });
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
  document.getElementById("pf-selling-type").value = product[PRODUCT_SELLING_TYPE_FIELD] || "";
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
        wholesale: isObject ? parsePriceNumber(v.wholesalePrice) : "",
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
    row.querySelector(".variant-editor__wholesale").value = prefill.wholesale ?? "";
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
    wholesaleRaw: row.querySelector(".variant-editor__wholesale").value,
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

// Prices are stored as text like "₱45.00" — the stock log needs a real
// number (null when there's no usable price).
function priceToNumberOrNull(value) {
  if (typeof value === "number") return isNaN(value) ? null : value;
  const parsed = parseFloat(String(value ?? "").replace(/[^\d.]/g, ""));
  return isNaN(parsed) ? null : parsed;
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
  const sellingType = document.getElementById("pf-selling-type").value;
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
    [PRODUCT_SELLING_TYPE_FIELD]: sellingType || null,
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

      const wholesale = row.wholesaleRaw === "" ? null : Number(row.wholesaleRaw);
      if (row.wholesaleRaw !== "" && (isNaN(wholesale) || wholesale < 0)) {
        showFormStatus(`Check the wholesale price for variant "${row.name}" — must be a valid, non-negative number.`, "error");
        return;
      }

      flavors.push({
        name: row.name,
        [VARIANT_STOCK_FIELD]: stockCount,
        [PRODUCT_PRICE_FIELD]: formatPrice(price),
        wholesalePrice: wholesale != null ? formatPrice(wholesale) : null,
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
      rawCsvRows = results.data;
      remapAndRenderCsvPreview();
    },
    error: (error) => {
      console.error("Couldn't parse CSV:", error);
      window.alert("Couldn't read that CSV file. Please check the format and try again.");
    }
  });
}

// Re-runs the raw→product mapping (honoring the current ignore-qty
// checkbox state) and re-renders the preview — used both on first
// parse and whenever the checkbox is toggled, without re-parsing the file.
function remapAndRenderCsvPreview() {
  const ignoreQty = document.getElementById("csv-ignore-qty").checked;
  parsedCsvRows = rawCsvRows.map((row) => csvRowToProduct(row, ignoreQty));
  renderCsvPreview();
}

// Rejects the file entirely — no preview, no row data, Confirm Import
// stays disabled — until a CSV with the correct headers is uploaded.
function showCsvHeaderError(missingHeaders) {
  rawCsvRows = [];
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

function csvRowToProduct(rawRow, ignoreQty) {
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
  // Optional column — not in CSV_COLUMN_MAP/EXPECTED_CSV_HEADERS on
  // purpose, so older CSV files without this column still import fine
  // (sellingType just comes through as null/not set).
  const sellingType = normalizeSellingType(get("selling_type"));

  return {
    [PRODUCT_NAME_FIELD]: name,
    [PRODUCT_CATEGORY_FIELD]: category,
    sku: get("sku") || null,
    principal: get("principal") || null,
    unit: get("unit") || null,
    [PRODUCT_SELLING_TYPE_FIELD]: sellingType,
    // When ignoreQty is true, stock is deliberately left unset (null)
    // rather than trusting a "qty" column that isn't confirmed
    // accurate — shows correctly as "Stock Not Set" instead of
    // falsely appearing In Stock. See CHUNK 0 note above.
    [STOCK_FIELD]: ignoreQty ? null : (isNaN(stockCount) ? 0 : stockCount),
    qty1: isNaN(qty1) ? null : qty1,
    qty2: isNaN(qty2) ? null : qty2,
    [PRODUCT_PRICE_FIELD]: isNaN(priceNum) ? "₱0.00" : formatPrice(priceNum),
    wholesalePrice: isNaN(wsNum) ? null : formatPrice(wsNum),
    [PRODUCT_AVAILABLE_FIELD]: ignoreQty ? null : true,
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
      <td></td><td></td><td></td><td></td><td></td><td></td>
    `;
    const cells = tr.querySelectorAll("td");
    cells[0].textContent = row[PRODUCT_NAME_FIELD] || "(missing name)";
    cells[1].textContent = row[PRODUCT_CATEGORY_FIELD] || "(missing category)";
    cells[2].textContent = row[PRODUCT_SELLING_TYPE_FIELD] ? SELLING_TYPE_LABELS[row[PRODUCT_SELLING_TYPE_FIELD]] : "—";
    cells[3].textContent = typeof row[STOCK_FIELD] === "number" ? row[STOCK_FIELD] : "Not set";
    cells[4].textContent = row[PRODUCT_PRICE_FIELD];
    cells[5].textContent = row.sku || "—";
    tbody.appendChild(tr);
  });
}

function closeCsvModal() {
  document.getElementById("csv-modal-overlay").hidden = true;
  hideCsvStatus();
  parsedCsvRows = [];
  rawCsvRows = [];
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
  document.getElementById("scanner-add-new-btn").hidden = true;
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

    const addNewBtn = document.getElementById("scanner-add-new-btn");
    if (isAdmin) {
      addNewBtn.hidden = false;
      addNewBtn.onclick = () => {
        closeScannerModal();
        openAddModal();
        document.getElementById("pf-barcode").value = barcode;
      };
    } else {
      addNewBtn.hidden = true;
    }
    return;
  }

  document.getElementById("scanner-add-new-btn").hidden = true;

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
      newStock: result.newStock,
      unitPrice: scannerMode === "sale" ? result.unitPrice : null
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
        variantName: null,
        unitPrice: priceToNumberOrNull(data[PRODUCT_PRICE_FIELD])
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
      variantName: variant.name || "Variant",
      unitPrice: priceToNumberOrNull(variant[PRODUCT_PRICE_FIELD]) ?? priceToNumberOrNull(data[PRODUCT_PRICE_FIELD])
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

function logStockMovement({ productId, productName, variantName, type, previousStock, newStock, unitPrice }) {
  // Fire-and-forget on purpose — a failed log write shouldn't block
  // or roll back the actual stock change, which already succeeded.
  addDoc(collection(db, STOCK_MOVEMENTS_COLLECTION), {
    productId,
    productName,
    variantName: variantName || null,
    type,
    previousStock,
    newStock,
    // Only meaningful for sales — captured at the exact moment of
    // sale so future sales reports can compute real revenue instead
    // of estimating from whatever the CURRENT price happens to be,
    // which could easily differ from what it was on the actual day.
    unitPrice: typeof unitPrice === "number" ? unitPrice : null,
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

// ====================================================================
// CHUNK 10 — BULK SELECT / DELETE (admin only)
// ----------------------------------------------------------------
// Select individual rows, or all currently-visible rows via the
// header checkbox, then delete them in one batch. Gated behind a
// REAL password check (PasswordConfirm.js reauthenticates against
// Firebase, not just a click-through dialog) since this is
// permanent and irreversible — "strict validation" for a
// destructive bulk action.
// ====================================================================
function updateBulkDeleteBar() {
  const bar = document.getElementById("bulk-delete-bar");
  const count = selectedProductIds.size;
  bar.hidden = count === 0;
  document.getElementById("bulk-delete-count").textContent =
    `${count} selected`;
}

function handleSelectAllToggle(event) {
  const checked = event.target.checked;
  document.querySelectorAll(".inventory-row-checkbox").forEach((checkbox) => {
    checkbox.checked = checked;
    checkbox.dispatchEvent(new Event("change"));
  });
}

async function handleBulkDelete() {
  const ids = Array.from(selectedProductIds);
  if (ids.length === 0) return;

  const verified = await promptPasswordConfirm(
    `Enter your password to permanently delete ${ids.length} product${ids.length === 1 ? "" : "s"}. This can't be undone.`,
    {
      title: `Delete ${ids.length} product${ids.length === 1 ? "" : "s"}?`,
      confirmLabel: "Delete"
    }
  );
  if (!verified) return;

  const deleteBtn = document.getElementById("bulk-delete-btn");
  deleteBtn.disabled = true;
  deleteBtn.textContent = "Deleting...";

  try {
    // Firestore batches cap at 500 ops — chunk just like CSV import.
    const BATCH_LIMIT = 450;
    for (let i = 0; i < ids.length; i += BATCH_LIMIT) {
      const chunk = ids.slice(i, i + BATCH_LIMIT);
      const batch = writeBatch(db);
      chunk.forEach((id) => batch.delete(doc(db, PRODUCTS_COLLECTION, id)));
      await batch.commit();
    }

    selectedProductIds.clear();
    await reloadAfterWrite();
  } catch (error) {
    console.error("Couldn't delete selected products:", error);
    window.alert("Something went wrong deleting some products. Check your inventory list — some may not have been removed.");
  } finally {
    deleteBtn.disabled = false;
    deleteBtn.textContent = "Delete Selected";
    updateBulkDeleteBar();
  }
}

// ====================================================================
// DISCOUNTS (admin only)
// ----------------------------------------------------------------
// HOW IT'S STORED: a product's `price` (and each variant's `price`)
// ALWAYS stays the regular price. A discount is three extra fields on
// the product:
//   discountPercent — number, e.g. 10
//   discountStart   — Timestamp, 12:00 AM on the first day (local time)
//   discountEnd     — Timestamp, 11:59 PM on the last day; absent = no end
// Whoever shows or charges a price (this page, the mobile app) works
// out the effective price from those fields and the current time.
// That's deliberate: there's no server here to change prices when a
// sale starts or ends, so the dates themselves decide. The mobile app
// has to apply the same rule or it will keep showing the regular price.
// Only retail prices are discounted — wholesale is left alone.
//
// LEGACY: an earlier version rewrote `price` and kept the old one in
// `originalPrice`. Those products still display correctly, and
// applying or removing a discount converts them to the format above.
// ====================================================================
const DISCOUNT_PERCENT_FIELD = "discountPercent";
const DISCOUNT_START_FIELD   = "discountStart";
const DISCOUNT_END_FIELD     = "discountEnd";
const LEGACY_ORIGINAL_PRICE_FIELD = "originalPrice";
const DISCOUNT_BATCH_LIMIT   = 450;
let discountPickedIds = new Map();     // product id -> its own % ("" = use the main Discount box)
let discountCategoryPicks = new Map(); // category -> its own % ("" = use the main Discount box)

// Handles a real Timestamp, and the {seconds, nanoseconds} plain object
// a Timestamp turns into after a trip through the sessionStorage cache.
function timeValueToMillis(value) {
  if (value === null || value === undefined) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.seconds === "number") return value.seconds * 1000;
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return isNaN(parsed) ? null : parsed;
}

// "none" | "scheduled" | "active" | "ended"
function getDiscountState(product, now = Date.now()) {
  const percent = product[DISCOUNT_PERCENT_FIELD];
  if (typeof percent !== "number" || percent <= 0) return "none";
  const start = timeValueToMillis(product[DISCOUNT_START_FIELD]);
  const end = timeValueToMillis(product[DISCOUNT_END_FIELD]);
  if (start !== null && now < start) return "scheduled";
  if (end !== null && now > end) return "ended";
  return "active";
}

function isLegacyDiscounted(product) {
  return Boolean(product[LEGACY_ORIGINAL_PRICE_FIELD])
    || getVariants(product).some((v) => v && typeof v === "object" && v[LEGACY_ORIGINAL_PRICE_FIELD]);
}

function formatPercent(value) {
  return String(Number(Number(value).toFixed(2)));
}

function formatShortDate(millis) {
  return new Date(millis).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatLongDate(date) {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function discountedPrice(baseValue, percent) {
  const base = parsePriceNumber(baseValue);
  if (base === "" || base <= 0) return null;
  return formatPrice(Math.round(base * (100 - percent)) / 100);
}

// The price a customer pays right now for an item whose regular price
// is `regularPrice` (a "₱45.00" string).
function effectivePriceString(regularPrice, product) {
  if (isLegacyDiscounted(product)) return regularPrice; // already rewritten by the old version
  if (getDiscountState(product) !== "active") return regularPrice;
  return discountedPrice(regularPrice, product[DISCOUNT_PERCENT_FIELD]) || regularPrice;
}

function buildDiscountPill(product) {
  const state = getDiscountState(product);
  if (state === "none") return null;

  const percentText = `${formatPercent(product[DISCOUNT_PERCENT_FIELD])}%`;
  const start = timeValueToMillis(product[DISCOUNT_START_FIELD]);
  const end = timeValueToMillis(product[DISCOUNT_END_FIELD]);

  const pill = document.createElement("span");
  pill.className = `discount-pill discount-pill--${state}`;

  if (state === "active") {
    pill.textContent = `Discounted -${percentText}`;
    if (end !== null) pill.title = `Until ${formatShortDate(end)}`;
  } else if (state === "scheduled") {
    pill.textContent = `-${percentText} starts ${formatShortDate(start)}`;
  } else {
    pill.textContent = `-${percentText} ended`;
  }
  return pill;
}

function appendDiscountPill(cell, product) {
  const pill = buildDiscountPill(product);
  if (pill) cell.append(" ", pill);
}

function makeWasElement(text) {
  const was = document.createElement("span");
  was.className = "discount-was";
  was.textContent = text;
  return was;
}

function renderRetailPrice(cell, regularPrice, product) {
  cell.textContent = "";
  const effective = effectivePriceString(regularPrice, product);
  cell.append(effective || "—");

  const was = product[LEGACY_ORIGINAL_PRICE_FIELD] || (effective !== regularPrice ? regularPrice : null);
  if (was) cell.append(" ", makeWasElement(was));
  appendDiscountPill(cell, product);
}

function renderRetailVariantRange(cell, variants, product) {
  const shown = variants.map((v) =>
    v && typeof v === "object"
      ? { ...v, [PRODUCT_PRICE_FIELD]: effectivePriceString(v[PRODUCT_PRICE_FIELD], product) }
      : v
  );
  cell.textContent = variantPriceRange(shown);
  appendDiscountPill(cell, product);
}

function renderVariantRetail(el, regularPrice, product) {
  el.textContent = "";
  const effective = effectivePriceString(regularPrice, product);
  el.append(`Retail ${effective || "—"}`);
  if (effective && effective !== regularPrice) el.append(" ", makeWasElement(regularPrice));
}

function hasUsablePrice(value) {
  return parsePriceNumber(value) > 0;
}

// The regular price of the first priced item (variant or product), or
// null if there is nothing to discount.
function firstRegularPrice(product) {
  const variants = getVariants(product);
  if (variants.length > 0) {
    const variant = variants.find(
      (v) => v && typeof v === "object" && hasUsablePrice(v[LEGACY_ORIGINAL_PRICE_FIELD] || v[PRODUCT_PRICE_FIELD])
    );
    return variant ? (variant[LEGACY_ORIGINAL_PRICE_FIELD] || variant[PRODUCT_PRICE_FIELD]) : null;
  }
  const regular = product[LEGACY_ORIGINAL_PRICE_FIELD] || product[PRODUCT_PRICE_FIELD];
  return hasUsablePrice(regular) ? regular : null;
}

// Puts a legacy (price-rewritten) product back to its regular price.
function legacyRestoreUpdate(product) {
  const variants = getVariants(product);

  if (variants.length > 0) {
    const isLegacyVariant = (v) => v && typeof v === "object" && v[LEGACY_ORIGINAL_PRICE_FIELD];
    if (!variants.some(isLegacyVariant)) return {};
    return {
      [PRODUCT_VARIANTS_FIELD]: variants.map((variant) => {
        if (!isLegacyVariant(variant)) return variant;
        const { [LEGACY_ORIGINAL_PRICE_FIELD]: original, ...rest } = variant;
        return { ...rest, [PRODUCT_PRICE_FIELD]: original };
      })
    };
  }

  if (product[LEGACY_ORIGINAL_PRICE_FIELD]) {
    return {
      [PRODUCT_PRICE_FIELD]: product[LEGACY_ORIGINAL_PRICE_FIELD],
      [LEGACY_ORIGINAL_PRICE_FIELD]: deleteField()
    };
  }
  return {};
}

// Firestore update for applying the discount, or null if the product
// has no retail price to discount.
function buildApplyUpdate(product, percent, startTimestamp, endTimestamp) {
  if (firstRegularPrice(product) === null) return null;
  return {
    ...legacyRestoreUpdate(product),
    [DISCOUNT_PERCENT_FIELD]: percent,
    [DISCOUNT_START_FIELD]: startTimestamp,
    [DISCOUNT_END_FIELD]: endTimestamp || deleteField()
  };
}

function buildRemoveUpdate(product) {
  const hasDiscountData = [DISCOUNT_PERCENT_FIELD, DISCOUNT_START_FIELD, DISCOUNT_END_FIELD]
    .some((field) => product[field] !== undefined && product[field] !== null);
  if (!hasDiscountData && !isLegacyDiscounted(product)) return null;

  return {
    ...legacyRestoreUpdate(product),
    [DISCOUNT_PERCENT_FIELD]: deleteField(),
    [DISCOUNT_START_FIELD]: deleteField(),
    [DISCOUNT_END_FIELD]: deleteField()
  };
}

function getDiscountScope() {
  return document.querySelector('input[name="discount-scope"]:checked').value;
}

// The top "Discount (%)" box: the default used wherever a category or
// product row doesn't have its own %. null when empty or out of range.
function parseDiscountPercent(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return null;
  const n = Number(text);
  return !isNaN(n) && n > 0 && n <= 99 ? n : null;
}

function readDefaultPercent() {
  return parseDiscountPercent(document.getElementById("discount-percent").value);
}

// Who the action applies to, and each one's percentage.
// Returns { entries: [{ product, percent }], problem } — `problem` is a
// message about the first row that has no usable percentage (only
// checked when needPercent is true, i.e. for Apply, not Remove).
function getDiscountPlan(needPercent) {
  const scope = getDiscountScope();
  const defaultPercent = readDefaultPercent();
  const entries = [];
  let problem = null;

  const resolve = (overrideRaw, label) => {
    if (!needPercent) return null;
    const hasOverride = String(overrideRaw ?? "").trim() !== "";
    const percent = hasOverride ? parseDiscountPercent(overrideRaw) : defaultPercent;
    if (percent === null && !problem) {
      if (hasOverride) problem = `${label}: enter a discount between 0.01 and 99%.`;
      else if (scope === "all") problem = "Enter a discount between 0.01 and 99%.";
      else problem = `Set a discount % for ${label}, or fill in the main Discount box.`;
    }
    return percent;
  };

  if (scope === "category") {
    discountCategoryPicks.forEach((overrideRaw, category) => {
      const percent = resolve(overrideRaw, `"${category}"`);
      allProducts
        .filter((p) => p[PRODUCT_CATEGORY_FIELD] === category)
        .forEach((product) => entries.push({ product, percent }));
    });
  } else if (scope === "selected") {
    allProducts.forEach((product) => {
      if (!discountPickedIds.has(product.id)) return;
      const percent = resolve(discountPickedIds.get(product.id), `"${product[PRODUCT_NAME_FIELD] || "Unnamed product"}"`);
      entries.push({ product, percent });
    });
  } else {
    const percent = resolve("", "all products");
    allProducts.forEach((product) => entries.push({ product, percent }));
  }

  return { entries, problem };
}

// "10%" when everything gets the same %, "5%–40%" when it varies.
function describePercents(percents) {
  const valid = percents.filter((p) => typeof p === "number");
  if (valid.length === 0) return { label: "", varies: false };
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  return min === max
    ? { label: `${formatPercent(min)}%`, varies: false }
    : { label: `${formatPercent(min)}%–${formatPercent(max)}%`, varies: true };
}

// Date inputs give "YYYY-MM-DD"; build local-time Dates from the parts
// (Date.parse on that string would read it as UTC and shift the day).
function dateFromInput(value, endOfDay) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return endOfDay
    ? new Date(year, month - 1, day, 23, 59, 59, 999)
    : new Date(year, month - 1, day, 0, 0, 0, 0);
}

function toDateInputValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Returns { start, end } (end may be null = no end date) or { error }.
function readDiscountDates() {
  const start = dateFromInput(document.getElementById("discount-start").value, false);
  if (!start) return { error: "Pick a start date." };

  const endRaw = document.getElementById("discount-end").value;
  const end = dateFromInput(endRaw, true);
  if (endRaw && !end) return { error: "That end date isn't valid." };
  if (end && end < start) return { error: "The end date can't be before the start date." };

  return { start, end };
}

function describeDiscountPeriod(dates) {
  return dates.end
    ? `${formatLongDate(dates.start)} to ${formatLongDate(dates.end)}`
    : `${formatLongDate(dates.start)}, no end date`;
}

function showDiscountStatus(message, kind) {
  const el = document.getElementById("discount-status");
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
}

function hideDiscountStatus() {
  document.getElementById("discount-status").hidden = true;
}

function emptySelectionMessage() {
  const scope = getDiscountScope();
  if (scope === "category") return "Tick at least one category first.";
  if (scope === "selected") return "Pick at least one product first.";
  return "There are no products.";
}

function updateDiscountSummary() {
  const scope = getDiscountScope();
  document.getElementById("discount-panel-category").hidden = scope !== "category";
  document.getElementById("discount-panel-selected").hidden = scope !== "selected";

  const { entries } = getDiscountPlan(true);
  const summary = document.getElementById("discount-summary");
  const count = `${entries.length} product${entries.length === 1 ? "" : "s"}`;

  if (scope === "selected") {
    document.getElementById("discount-picked-count").textContent =
      `${discountPickedIds.size} product${discountPickedIds.size === 1 ? "" : "s"} selected`;
  }

  if (entries.length === 0) {
    summary.textContent = emptySelectionMessage().replace(" first.", ".");
    return;
  }

  const { label, varies } = describePercents(entries.map((e) => e.percent));
  let text = label
    ? `${label} off ${count}${varies ? " (varies by row)" : ""}.`
    : `Applies to ${count}.`;

  if (label) {
    const dates = readDiscountDates();
    if (!dates.error) text += ` ${describeDiscountPeriod(dates)}.`;

    const sample = entries.find((e) => e.percent !== null && firstRegularPrice(e.product) !== null);
    if (sample) {
      const regular = firstRegularPrice(sample.product);
      text += ` e.g. ${sample.product[PRODUCT_NAME_FIELD] || "Product"}: ${regular} → ${discountedPrice(regular, sample.percent)}`;
    }
  }
  summary.textContent = text;
}

function defaultPercentPlaceholder() {
  const percent = readDefaultPercent();
  return percent ? `${formatPercent(percent)}%` : "%";
}

function refreshOverridePlaceholders() {
  const placeholder = defaultPercentPlaceholder();
  document.querySelectorAll(".discount-override").forEach((input) => { input.placeholder = placeholder; });
}

// The small per-row % box. Only visible while the row is ticked; empty
// means "use the main Discount (%)".
function createOverrideInput(value, hidden, onChange) {
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0.01";
  input.max = "99";
  input.step = "0.01";
  input.className = "discount-override";
  input.placeholder = defaultPercentPlaceholder();
  input.value = value;
  input.hidden = hidden;
  input.setAttribute("aria-label", "Discount percent for this row");
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("input", () => { hideDiscountStatus(); onChange(input.value); });
  return input;
}

function renderDiscountCategoryList() {
  const list = document.getElementById("discount-category-list");
  list.innerHTML = "";

  const counts = new Map();
  allProducts.forEach((p) => {
    const category = p[PRODUCT_CATEGORY_FIELD];
    if (category) counts.set(category, (counts.get(category) || 0) + 1);
  });
  const categories = [...counts.keys()].sort();

  if (categories.length === 0) {
    list.innerHTML = `<p class="discount-picker__empty">No categories yet.</p>`;
    return;
  }

  categories.forEach((category) => {
    const label = document.createElement("label");
    label.className = "discount-picker__item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = discountCategoryPicks.has(category);

    const name = document.createElement("span");
    name.className = "discount-picker__name";
    name.textContent = category;

    const meta = document.createElement("span");
    meta.className = "discount-picker__meta";
    meta.textContent = `${counts.get(category)} product${counts.get(category) === 1 ? "" : "s"}`;

    const input = createOverrideInput(
      discountCategoryPicks.get(category) ?? "",
      !checkbox.checked,
      (value) => { discountCategoryPicks.set(category, value); updateDiscountSummary(); }
    );

    checkbox.addEventListener("change", () => {
      if (checkbox.checked) discountCategoryPicks.set(category, input.value);
      else discountCategoryPicks.delete(category);
      input.hidden = !checkbox.checked;
      hideDiscountStatus();
      updateDiscountSummary();
    });

    label.append(checkbox, name, meta, input);
    list.appendChild(label);
  });
}

function renderDiscountPicker() {
  const list = document.getElementById("discount-picker-list");
  const term = document.getElementById("discount-product-search").value.trim().toLowerCase();
  list.innerHTML = "";

  const matches = allProducts
    .filter((p) => fuzzyMatch(term, p[PRODUCT_NAME_FIELD] || ""))
    .sort((a, b) => (a[PRODUCT_NAME_FIELD] || "").localeCompare(b[PRODUCT_NAME_FIELD] || ""));

  if (matches.length === 0) {
    list.innerHTML = `<p class="discount-picker__empty">No products match.</p>`;
    return;
  }

  matches.forEach((product) => {
    const label = document.createElement("label");
    label.className = "discount-picker__item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = discountPickedIds.has(product.id);

    const name = document.createElement("span");
    name.className = "discount-picker__name";
    name.textContent = product[PRODUCT_NAME_FIELD] || "Unnamed product";

    const meta = document.createElement("span");
    meta.className = "discount-picker__meta";
    const variants = getVariants(product);
    meta.textContent = `${product[PRODUCT_CATEGORY_FIELD] || "—"} · ${variants.length > 0 ? variantPriceRange(variants) : (product[PRODUCT_PRICE_FIELD] || "—")}`;

    const input = createOverrideInput(
      discountPickedIds.get(product.id) ?? "",
      !checkbox.checked,
      (value) => { discountPickedIds.set(product.id, value); updateDiscountSummary(); }
    );

    checkbox.addEventListener("change", () => {
      if (checkbox.checked) discountPickedIds.set(product.id, input.value);
      else discountPickedIds.delete(product.id);
      input.hidden = !checkbox.checked;
      hideDiscountStatus();
      updateDiscountSummary();
    });

    label.append(checkbox, name, meta);
    const pill = buildDiscountPill(product);
    if (pill) label.append(pill);
    label.append(input);
    list.appendChild(label);
  });
}

function openDiscountModal() {
  hideDiscountStatus();
  document.getElementById("discount-percent").value = "";
  document.getElementById("discount-start").value = toDateInputValue(new Date());
  document.getElementById("discount-end").value = "";
  document.getElementById("discount-product-search").value = "";

  discountCategoryPicks = new Map();
  // Anything already ticked in the table carries over as the starting selection.
  discountPickedIds = new Map([...selectedProductIds].map((id) => [id, ""]));
  const startScope = discountPickedIds.size > 0 ? "selected" : "all";
  document.querySelector(`input[name="discount-scope"][value="${startScope}"]`).checked = true;

  renderDiscountCategoryList();
  renderDiscountPicker();
  updateDiscountSummary();
  document.getElementById("discount-modal-overlay").hidden = false;
  document.getElementById("discount-percent").focus();
}

function closeDiscountModal() {
  document.getElementById("discount-modal-overlay").hidden = true;
}

function wireDiscountControls() {
  document.getElementById("discount-btn").addEventListener("click", openDiscountModal);
  document.getElementById("discount-modal-close").addEventListener("click", closeDiscountModal);
  document.getElementById("discount-cancel").addEventListener("click", closeDiscountModal);

  const refresh = () => { hideDiscountStatus(); updateDiscountSummary(); };
  document.querySelectorAll('input[name="discount-scope"]').forEach((radio) => radio.addEventListener("change", refresh));
  document.getElementById("discount-percent").addEventListener("input", () => { refreshOverridePlaceholders(); refresh(); });
  document.getElementById("discount-start").addEventListener("input", refresh);
  document.getElementById("discount-end").addEventListener("input", refresh);
  document.getElementById("discount-product-search").addEventListener("input", renderDiscountPicker);

  document.getElementById("discount-apply").addEventListener("click", () => runDiscountAction("apply"));
  document.getElementById("discount-remove").addEventListener("click", () => runDiscountAction("remove"));
}

function quotedList(names) {
  const quoted = names.map((n) => `"${n}"`);
  return quoted.length <= 1 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

// "all products" | 'the "Paper" category' | '"Paper" and "Snacks" categories'
// | "3 selected products"
function describeDiscountScope() {
  const scope = getDiscountScope();
  if (scope === "category") {
    const names = [...discountCategoryPicks.keys()].sort();
    if (names.length === 1) return `the "${names[0]}" category`;
    if (names.length <= 3) return `the ${quotedList(names)} categories`;
    return `${names.length} categories`;
  }
  if (scope === "selected") {
    const n = discountPickedIds.size;
    return `${n} selected product${n === 1 ? "" : "s"}`;
  }
  return "all products";
}

// Frosted-glass confirmation shown after Apply / Remove succeeds.
function showDiscountResultOverlay({ action, scopeLabel, percentLabel, varies, dates, count, pushNote }) {
  const isApply = action === "apply";
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay glass-overlay";

  const detail = isApply
    ? `${percentLabel} off${varies ? " (varies)" : ""} · ${describeDiscountPeriod(dates)}`
    : "Prices are back to regular.";

  overlay.innerHTML = `
    <div class="glass-card" role="status">
      <div class="glass-card__icon">
        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7"/>
          <path d="M8 12.5L10.8 15.3L16 9.6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <h3></h3>
      <p class="glass-card__message"></p>
      <p class="glass-card__detail"></p>
      <button type="button" class="btn-primary" id="discount-result-dismiss">Okay</button>
    </div>
  `;

  overlay.querySelector("h3").textContent = isApply ? "Discount Applied" : "Discount Removed";
  overlay.querySelector(".glass-card__message").textContent = isApply
    ? `Discount applied to ${scopeLabel}.`
    : `Discount removed from ${scopeLabel}.`;
  overlay.querySelector(".glass-card__detail").textContent =
    `${count} product${count === 1 ? "" : "s"} updated · ${detail}`;

  if (pushNote) {
    const noteEl = document.createElement("p");
    noteEl.className = "glass-card__detail";
    noteEl.textContent = pushNote;
    overlay.querySelector(".glass-card__detail").after(noteEl);
  }

  document.body.appendChild(overlay);
  const dismiss = () => overlay.remove();
  overlay.querySelector("#discount-result-dismiss").addEventListener("click", dismiss);
  overlay.addEventListener("click", (event) => { if (event.target === overlay) dismiss(); });
}

// ====================================================================
// PROMOTION PUSH — discount went live
// ----------------------------------------------------------------
// Only products whose discount is ACTIVE right now (start date reached,
// not already ended) and that are actually in stock trigger a push. A
// discount scheduled for a later start date sends nothing — there is no
// server here to fire it on that day.
// One product → "<Name>" is now on sale!; two or more in the same action →
// a single generic push, so a multi-product discount is never a burst.
// ====================================================================
function isProductInStock(product) {
  const variants = getVariants(product);
  if (variants.length > 0) {
    return variants.some((variant) => {
      if (!variant || typeof variant !== "object") return true;
      return getStockStatus(variant[VARIANT_STOCK_FIELD], variant[PRODUCT_AVAILABLE_FIELD]) !== "out";
    });
  }
  return getStockStatus(product[STOCK_FIELD], product[PRODUCT_AVAILABLE_FIELD]) !== "out";
}

async function notifyDiscountLive(updates, entries, dates) {
  const now = Date.now();
  const startedYet = dates.start.getTime() <= now;
  const notEnded = !dates.end || dates.end.getTime() >= now;
  if (!startedYet) {
    return { note: "Starts later — no push sent now." };
  }
  if (!notEnded) return { note: "" };

  const productById = new Map(entries.map(({ product }) => [product.id, product]));
  const live = updates
    .map(({ id, percent }) => ({ product: productById.get(id), percent }))
    .filter(({ product, percent }) => product && percent > 0 && isProductInStock(product));

  if (live.length === 0) return { note: "" };

  // Exactly one product → name it. Two or more discounted in the same
  // action → ONE generic push, never one per product.
  const result = await sendPromotionPushes(live, {
    maxIndividual: 1,
    one: ({ product }) => `"${product[PRODUCT_NAME_FIELD] || "A product"}" is now on sale!`,
    many: () => "Some products are discounted! Shop now and don't miss the offer."
  });

  return { note: result.ok ? "Customers with promotions on were notified." : "Discount saved, but the customer push couldn't be sent." };
}

async function runDiscountAction(action) {
  hideDiscountStatus();
  const isApply = action === "apply";
  const { entries, problem } = getDiscountPlan(isApply);

  if (entries.length === 0) {
    showDiscountStatus(emptySelectionMessage(), "error");
    return;
  }

  let dates = null;
  let updates;

  if (isApply) {
    if (problem) {
      showDiscountStatus(problem, "error");
      return;
    }
    dates = readDiscountDates();
    if (dates.error) {
      showDiscountStatus(dates.error, "error");
      return;
    }

    const startTimestamp = Timestamp.fromDate(dates.start);
    const endTimestamp = dates.end ? Timestamp.fromDate(dates.end) : null;
    updates = entries
      .map(({ product, percent }) => ({
        id: product.id,
        percent,
        update: buildApplyUpdate(product, percent, startTimestamp, endTimestamp)
      }))
      .filter((x) => x.update);
    if (updates.length === 0) {
      showDiscountStatus("None of these products have a retail price to discount.", "error");
      return;
    }
  } else {
    // Removing works on any discount — running, scheduled or already ended.
    updates = entries
      .map(({ product }) => ({ id: product.id, percent: null, update: buildRemoveUpdate(product) }))
      .filter((x) => x.update);
    if (updates.length === 0) {
      showDiscountStatus("None of these products currently have a discount.", "error");
      return;
    }
  }

  const noun = `${updates.length} product${updates.length === 1 ? "" : "s"}`;
  const scopeLabel = describeDiscountScope();
  const { label: percentLabel, varies } = describePercents(updates.map((u) => u.percent));
  const skipped = entries.length - updates.length;
  const skippedNote = isApply && skipped > 0 ? `\n${skipped} skipped (no retail price).` : "";

  const confirmed = await confirmDialog(
    isApply
      ? `${percentLabel} off retail price on ${noun}${varies ? " (the percentage varies by category/product)" : ""}.\n${describeDiscountPeriod(dates)}.\nAny existing discount on these is replaced, not stacked.${skippedNote}`
      : `Remove the discount (including any scheduled or ended one) from ${noun}?`,
    {
      title: isApply ? "Apply discount?" : "Remove discount?",
      confirmLabel: isApply ? "Apply Discount" : "Remove Discount"
    }
  );
  if (!confirmed) return;

  const applyBtn = document.getElementById("discount-apply");
  const removeBtn = document.getElementById("discount-remove");
  const activeBtn = isApply ? applyBtn : removeBtn;
  const activeLabel = activeBtn.textContent;
  applyBtn.disabled = true;
  removeBtn.disabled = true;
  activeBtn.textContent = isApply ? "Applying..." : "Removing...";

  try {
    for (let i = 0; i < updates.length; i += DISCOUNT_BATCH_LIMIT) {
      const batch = writeBatch(db);
      updates.slice(i, i + DISCOUNT_BATCH_LIMIT).forEach(({ id, update }) => {
        batch.update(doc(db, PRODUCTS_COLLECTION, id), update);
      });
      await batch.commit();
    }

    await reloadAfterWrite();
    closeDiscountModal();

    // Tell customers (promotions-enabled devices only) about discounts that
    // are live right now. Runs after the save succeeded; a failed push never
    // undoes the discount.
    let pushNote = "";
    if (isApply) {
      const pushResult = await notifyDiscountLive(updates, entries, dates);
      pushNote = pushResult.note;
    }

    showDiscountResultOverlay({ action, scopeLabel, percentLabel, varies, dates, count: updates.length, pushNote });
  } catch (error) {
    console.error("Couldn't update discounts:", error);
    showDiscountStatus("Something went wrong. Some products may have been updated — check the list and try again.", "error");
  } finally {
    applyBtn.disabled = false;
    removeBtn.disabled = false;
    activeBtn.textContent = activeLabel;
  }
}
