import { db } from "./firebase-config.js";
import {
  collection, getDocs, query, where
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getProducts } from "./ProductCache.js";
import { kMeansCluster, normalizeFeatures } from "./KMeans.js";

// ====================================================================
// FORECAST — AI-assisted demand trend & restock recommendations
// ----------------------------------------------------------------
// NOT traditional sales-history forecasting — this store has no
// dedicated point-of-sale transaction log. What it uses instead is
// real data already collected, from TWO sources, merged together:
//
//   1. Stock Movement Log — every "sale" entry, written when a
//      barcode scan records a real in-store sale (see
//      performScanAction() in Inventory.js).
//   2. Online Orders — every item inside an order with
//      status === "delivered" (not pending/cancelled/rejected —
//      only orders that actually resulted in stock leaving the
//      store count as a real completed sale).
//
// Both are genuine, timestamped depletion events, just from two
// different parts of the business (in-store vs. online). Combining
// them gives a truer picture of real demand than either alone would.
//
// From that, this computes a real per-product SELLING VELOCITY
// (units/day) and feeds it into K-MEANS CLUSTERING (see KMeans.js) —
// genuine unsupervised machine learning — which automatically groups
// products into Fast-Moving / Moderate / Slow-Moving, discovering the
// natural breakpoints from the actual data rather than a hardcoded
// "fast = 5/day" rule. This improves automatically as more real sales
// data (from either source) accumulates — no retraining step needed.
//
// HONEST LIMITATION: a product with zero recorded sales from EITHER
// source has no velocity to compute — it's shown separately as
// "No Sales Data Yet," not guessed at or hidden.
//
// HONEST APPROXIMATION: online order timestamps use the order's
// createdAt (creation time), not a separate delivery-confirmation
// timestamp — the schema doesn't currently track the latter
// separately, so creation time is used as a reasonable stand-in.
// ====================================================================
const STOCK_MOVEMENTS_COLLECTION = "stockMovements";
const ORDERS_COLLECTION = "orders";
const CLUSTER_COUNT = 3; // Fast-Moving / Moderate / Slow-Moving

// UPDATE THIS after deploying the Worker (see gemini-worker.js) — it'll
// be shown in the Cloudflare dashboard right after deployment, looks
// like "https://your-worker-name.your-subdomain.workers.dev"
const GEMINI_WORKER_URL = "https://gemini-forecast-proxy.eldefonsojrletigio.workers.dev";

let allProducts = [];
let velocityByProductId = new Map();

document.addEventListener("sidebar:ready", () => {
  loadForecast();
});

async function loadForecast() {
  showLoadingState();

  try {
    const [products, saleMovements, deliveredOrderItems] = await Promise.all([
      getProducts(),
      fetchSaleMovements(),
      fetchDeliveredOrderItems()
    ]);

    allProducts = products;
    velocityByProductId = computeVelocities([...saleMovements, ...deliveredOrderItems]);

    const productsWithData = [];
    const productsWithoutData = [];

    products.forEach((product) => {
      const velocityInfo = velocityByProductId.get(product.id);
      const currentStock = getProductCurrentStock(product);

      if (velocityInfo) {
        productsWithData.push({
          product,
          currentStock,
          ...velocityInfo,
          daysUntilStockout: velocityInfo.velocity > 0 ? currentStock / velocityInfo.velocity : null
        });
      } else {
        productsWithoutData.push({ product, currentStock });
      }
    });

    const clustered = clusterByVelocity(productsWithData);

    renderResults(clustered, productsWithoutData);
  } catch (error) {
    console.error("Couldn't load forecast:", error);
    showErrorState();
  }
}

// ---- Data fetching ---------------------------------------------------
async function fetchSaleMovements() {
  const q = query(collection(db, STOCK_MOVEMENTS_COLLECTION), where("type", "==", "sale"));
  const snap = await getDocs(q);

  return snap.docs
    .map((docSnap) => {
      const data = docSnap.data();
      const unitsSold = (data.previousStock ?? 0) - (data.newStock ?? 0);
      const timestampMillis = data.createdAt?.toMillis?.();
      return { productId: data.productId, unitsSold, timestampMillis };
    })
    .filter((entry) => entry.productId && entry.unitsSold > 0 && entry.timestampMillis);
}

// Only "delivered" orders count — pending/approved/on_the_way haven't
// actually resulted in stock leaving yet, and cancelled/rejected/
// undelivered explicitly didn't. Flattens each order's items[] array
// into individual depletion events, one per line item.
async function fetchDeliveredOrderItems() {
  const q = query(collection(db, ORDERS_COLLECTION), where("status", "==", "delivered"));
  const snap = await getDocs(q);

  const events = [];
  snap.forEach((docSnap) => {
    const order = docSnap.data();
    const timestampMillis = order.createdAt?.toMillis?.();
    if (!timestampMillis || !Array.isArray(order.items)) return;

    order.items.forEach((item) => {
      const unitsSold = typeof item.amount === "number" ? item.amount : 0;
      if (item.productId && unitsSold > 0) {
        events.push({ productId: item.productId, unitsSold, timestampMillis });
      }
    });
  });

  return events;
}

// ---- Velocity computation ---------------------------------------------
// Aggregates all "sale" movements per product into a single velocity
// figure (units sold per day). Variant sales are combined into their
// parent product's total — a deliberate simplification; a future
// version could track per-variant velocity separately if that level
// of detail becomes worth the added complexity.
function computeVelocities(depletionEvents) {
  const byProduct = new Map();

  depletionEvents.forEach(({ productId, unitsSold, timestampMillis }) => {
    const existing = byProduct.get(productId) || {
      totalUnitsSold: 0,
      firstSaleMillis: timestampMillis,
      lastSaleMillis: timestampMillis
    };

    existing.totalUnitsSold += unitsSold;
    existing.firstSaleMillis = Math.min(existing.firstSaleMillis, timestampMillis);
    existing.lastSaleMillis = Math.max(existing.lastSaleMillis, timestampMillis);

    byProduct.set(productId, existing);
  });

  const result = new Map();
  const now = Date.now();

  byProduct.forEach((entry, productId) => {
    const daysActive = Math.max(1, (now - entry.firstSaleMillis) / (1000 * 60 * 60 * 24));
    const daysSinceLastSale = (now - entry.lastSaleMillis) / (1000 * 60 * 60 * 24);
    const velocity = entry.totalUnitsSold / daysActive;

    result.set(productId, {
      totalUnitsSold: entry.totalUnitsSold,
      velocity,
      daysSinceLastSale
    });
  });

  return result;
}

function getProductCurrentStock(product) {
  const variants = Array.isArray(product.flavors) ? product.flavors : [];
  if (variants.length > 0) {
    return variants.reduce((sum, v) => sum + (typeof v.stock === "number" ? v.stock : 0), 0);
  }
  return typeof product.stockCount === "number" ? product.stockCount : 0;
}

// ---- Clustering ---------------------------------------------------
function clusterByVelocity(productsWithData) {
  if (productsWithData.length === 0) {
    return { fast: [], moderate: [], slow: [] };
  }

  const rawFeatures = productsWithData.map((p) => [p.velocity, p.daysSinceLastSale]);
  const normalized = normalizeFeatures(rawFeatures);
  const { assignments, centroids } = kMeansCluster(normalized, Math.min(CLUSTER_COUNT, productsWithData.length));

  // Label clusters by their ACTUAL (non-normalized) average velocity —
  // k-means itself only produces anonymous group numbers; this maps
  // "highest average velocity" to "Fast-Moving", etc., so the labels
  // mean something to a person looking at them.
  const clusterVelocitySums = new Map();
  const clusterCounts = new Map();
  productsWithData.forEach((p, i) => {
    const cluster = assignments[i];
    clusterVelocitySums.set(cluster, (clusterVelocitySums.get(cluster) || 0) + p.velocity);
    clusterCounts.set(cluster, (clusterCounts.get(cluster) || 0) + 1);
  });

  const clusterAverages = Array.from(clusterVelocitySums.keys()).map((cluster) => ({
    cluster,
    avgVelocity: clusterVelocitySums.get(cluster) / clusterCounts.get(cluster)
  }));
  clusterAverages.sort((a, b) => b.avgVelocity - a.avgVelocity);

  const labelByCluster = new Map();
  clusterAverages.forEach((entry, rank) => {
    const label = clusterAverages.length === 1 ? "fast"
      : rank === 0 ? "fast"
      : rank === clusterAverages.length - 1 ? "slow"
      : "moderate";
    labelByCluster.set(entry.cluster, label);
  });

  const grouped = { fast: [], moderate: [], slow: [] };
  productsWithData.forEach((p, i) => {
    const label = labelByCluster.get(assignments[i]);
    p.velocityTier = label; // tagged here so later filters (e.g. "is this a fast-mover") can check it directly
    grouped[label].push(p);
  });

  Object.keys(grouped).forEach((key) => {
    grouped[key].sort((a, b) => b.velocity - a.velocity);
  });

  return grouped;
}

// ---- Rendering ---------------------------------------------------
function showLoadingState() {
  document.getElementById("forecast-content").innerHTML =
    `<p class="forecast-loading">Analyzing sales velocity...</p>`;
}

function showErrorState() {
  document.getElementById("forecast-content").innerHTML =
    `<p class="forecast-loading">Couldn't load forecast data right now.</p>`;
}

function renderResults(clustered, productsWithoutData) {
  const container = document.getElementById("forecast-content");
  container.innerHTML = "";

  const allTracked = [...clustered.fast, ...clustered.moderate, ...clustered.slow];

  if (allTracked.length === 0) {
    container.innerHTML = `
      <div class="forecast-empty">
        <h3>No sales data yet</h3>
        <p>This builds itself automatically from real barcode-scanned sales (Inventory → Scan Barcode → Record Sale). Once products start selling through the scanner, trends and restock recommendations will appear here — no setup needed.</p>
      </div>
    `;
    return;
  }

  const bestSellersOut = allTracked.filter((p) =>
    p.velocityTier === "fast" && p.currentStock === 0
  );
  const bestSellersAlmostOut = allTracked.filter((p) =>
    p.velocityTier === "fast" && p.currentStock > 0 && isLowOrOut(p.currentStock)
  );
  const restockRecommended = allTracked
    .filter((p) => isLowOrOut(p.currentStock))
    .sort((a, b) => (a.daysUntilStockout ?? Infinity) - (b.daysUntilStockout ?? Infinity));

  container.appendChild(buildSummaryCards(clustered, restockRecommended, productsWithoutData));

  const aiPanel = buildAiInsightPanel();
  container.insertBefore(aiPanel, container.firstChild);
  loadAiInsight(clustered, restockRecommended, allTracked.length, productsWithoutData.length, aiPanel);

  if (bestSellersOut.length > 0) {
    container.appendChild(buildSection(
      "Best Sellers Out of Stock",
      "Fast-moving products that have completely run out — restock these first, they're actively losing sales right now.",
      bestSellersOut,
      "urgent",
      "urgent"
    ));
  }

  if (bestSellersAlmostOut.length > 0) {
    container.appendChild(buildSection(
      "Best Sellers Almost Out of Stock",
      "Fast-moving products that need attention now — these sell quickly and are running low, but haven't run out yet.",
      bestSellersAlmostOut,
      "urgent",
      "urgent"
    ));
  }

  if (restockRecommended.length > 0) {
    container.appendChild(buildSection(
      "Recommended Restock",
      "Ranked by how soon each is projected to run out, based on current selling pace.",
      restockRecommended,
      "restock",
      "restock"
    ));
  }

  if (clustered.fast.length > 0) {
    container.appendChild(buildSection(
      "Fast-Moving Products",
      "Grouped automatically by K-Means clustering based on real sales velocity — not a fixed threshold.",
      clustered.fast,
      "trend",
      "trend"
    ));
  }

  if (clustered.moderate.length > 0 || clustered.slow.length > 0) {
    container.appendChild(buildSection(
      "Moderate & Slow-Moving",
      "Selling steadily but not urgently — included for visibility, not action.",
      [...clustered.moderate, ...clustered.slow],
      "trend",
      "trend"
    ));
  }

  if (productsWithoutData.length > 0) {
    container.appendChild(buildNoDataSection(productsWithoutData));
  }
}

function isLowOrOut(stock) {
  return stock <= 99; // matches the app-wide Low/Critical/Out thresholds
}

function getStockUrgency(entry) {
  return entry.currentStock === 0 ? "out" : entry.currentStock <= 49 ? "critical" : entry.currentStock <= 99 ? "low" : "in";
}

function buildSummaryCards(clustered, restockRecommended, productsWithoutData) {
  const wrap = document.createElement("div");
  wrap.className = "forecast-summary-grid";

  const cards = [
    { value: clustered.fast.length, label: "Fast-Moving Products" },
    { value: restockRecommended.length, label: "Need Restocking" },
    { value: clustered.moderate.length + clustered.slow.length, label: "Moderate / Slow-Moving" },
    { value: productsWithoutData.length, label: "No Sales Data Yet" }
  ];

  cards.forEach((card) => {
    const el = document.createElement("div");
    el.className = "panel forecast-stat-card";
    el.innerHTML = `<span class="forecast-stat-card__value"></span><span class="forecast-stat-card__label"></span>`;
    el.querySelector(".forecast-stat-card__value").textContent = card.value;
    el.querySelector(".forecast-stat-card__label").textContent = card.label;
    wrap.appendChild(el);
  });

  return wrap;
}

const SECTION_ICONS = {
  urgent: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12 9V13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M10.3 3.9L2.6 17.5C2.1 18.4 2.8 19.5 3.8 19.5H20.2C21.2 19.5 21.9 18.4 21.4 17.5L13.7 3.9C13.2 3 11.8 3 10.3 3.9Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="16.3" r="0.9" fill="currentColor"/></svg>`,
  restock: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12 3L20.5 7.5V16.5L12 21L3.5 16.5V7.5L12 3Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M3.5 7.5L12 12M12 12L20.5 7.5M12 12V21" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`,
  trend: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M3.5 17L9 11L13 15L20.5 6.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M14.5 6.5H20.5V12.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`
};

function buildSection(title, subtitle, entries, mode, iconKey) {
  const section = document.createElement("div");
  section.className = "panel forecast-section";
  section.innerHTML = `
    <h3 class="forecast-section__title">
      <span class="forecast-section__icon"></span>
      <span class="forecast-section__title-text"></span>
    </h3>
    <p class="forecast-section__subtitle"></p>
    <div class="forecast-list"></div>
  `;
  section.querySelector(".forecast-section__icon").innerHTML = SECTION_ICONS[iconKey] || SECTION_ICONS.trend;
  section.querySelector(".forecast-section__title-text").textContent = title;
  section.querySelector(".forecast-section__subtitle").textContent = subtitle;

  const list = section.querySelector(".forecast-list");
  entries.forEach((entry) => list.appendChild(buildEntryRow(entry, mode)));

  return section;
}

function buildEntryRow(entry, mode) {
  const row = document.createElement("div");
  row.className = "forecast-item";

  const name = entry.product.name || "Unnamed product";
  const velocityLabel = entry.velocity >= 1
    ? `~${entry.velocity.toFixed(1)} units/day`
    : `~${(entry.velocity * 7).toFixed(1)} units/week`;

  const stockoutLabel = entry.currentStock === 0
    ? "Out of stock"
    : entry.daysUntilStockout != null
      ? entry.daysUntilStockout < 1
        ? "Stockout imminent"
        : `~${Math.round(entry.daysUntilStockout)} days until stockout`
      : "";

  row.innerHTML = `
    <div class="forecast-item__thumb-wrap"></div>
    <div class="forecast-item__info">
      <strong class="forecast-item__name"></strong>
      <span class="forecast-item__meta"></span>
    </div>
    <div class="forecast-item__right"></div>
  `;

  const thumbWrap = row.querySelector(".forecast-item__thumb-wrap");
  if (entry.product.imageUrl) {
    const img = document.createElement("img");
    img.src = entry.product.imageUrl;
    img.alt = "";
    img.className = "forecast-item__thumb";
    thumbWrap.appendChild(img);
  } else {
    const empty = document.createElement("span");
    empty.className = "forecast-item__thumb forecast-item__thumb--empty";
    thumbWrap.appendChild(empty);
  }

  row.querySelector(".forecast-item__name").textContent = name;
  row.querySelector(".forecast-item__meta").textContent =
    `${velocityLabel}${stockoutLabel ? " · " + stockoutLabel : ""}`;

  const right = row.querySelector(".forecast-item__right");
  const stockBadge = document.createElement("span");
  const urgency = getStockUrgency(entry);
  stockBadge.className = `stock-badge stock-badge--${urgency}`;
  stockBadge.textContent = `${entry.currentStock} left`;
  right.appendChild(stockBadge);

  if (mode === "urgent") row.classList.add("forecast-item--urgent");

  return row;
}

function buildNoDataSection(productsWithoutData) {
  const section = document.createElement("div");
  section.className = "panel forecast-section forecast-section--muted";
  section.innerHTML = `
    <h3 class="forecast-section__title">No Sales Data Yet</h3>
    <p class="forecast-section__subtitle">${productsWithoutData.length} product${productsWithoutData.length === 1 ? " hasn't" : "s haven't"} been sold through the barcode scanner yet, so there's no real velocity to compute. They'll appear in the sections above automatically once they start selling.</p>
  `;
  return section;
}

// ---- AI Insight (Gemini, via Cloud Function) ----------------------
// Calls the secured Cloud Function (functions/index.js) with the
// already-computed forecast summary — never raw data, never an API
// key sitting anywhere in this file. Loads independently of the rest
// of the page (fire-and-forget after the main sections render), so a
// slow or failed AI response never blocks or breaks anything else.
function buildAiInsightPanel() {
  const panel = document.createElement("div");
  panel.className = "panel forecast-ai-panel";
  panel.innerHTML = `
    <div class="forecast-ai-panel__icon">
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M12 3L13.8 8.2L19 10L13.8 11.8L12 17L10.2 11.8L5 10L10.2 8.2L12 3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M18.5 15L19.3 17.2L21.5 18L19.3 18.8L18.5 21L17.7 18.8L15.5 18L17.7 17.2L18.5 15Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
      </svg>
    </div>
    <div class="forecast-ai-panel__body">
      <span class="forecast-ai-panel__label">AI Insight</span>
      <p class="forecast-ai-panel__text">Generating summary...</p>
    </div>
  `;
  return panel;
}

async function loadAiInsight(clustered, restockRecommended, totalTracked, noDataCount, panel) {
  const textEl = panel.querySelector(".forecast-ai-panel__text");

  try {
    const response = await fetch(GEMINI_WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fastMovers: clustered.fast.slice(0, 8).map((p) => ({
          name: p.product.name || "Unnamed product",
          velocity: Number(p.velocity.toFixed(1)),
          currentStock: p.currentStock
        })),
        moderateMovers: clustered.moderate.slice(0, 5).map((p) => ({
          name: p.product.name || "Unnamed product",
          velocity: Number(p.velocity.toFixed(1))
        })),
        slowMovers: clustered.slow.slice(0, 5).map((p) => ({
          name: p.product.name || "Unnamed product",
          velocity: Number(p.velocity.toFixed(2)),
          currentStock: p.currentStock
        })),
        restockRecommended: restockRecommended.slice(0, 8).map((p) => ({
          name: p.product.name || "Unnamed product",
          currentStock: p.currentStock,
          daysUntilStockout: p.daysUntilStockout != null ? Number(p.daysUntilStockout.toFixed(1)) : null,
          velocityTier: p.velocityTier
        })),
        totalTracked,
        noDataCount
      })
    });

    if (!response.ok) throw new Error(`Worker returned ${response.status}`);

    const result = await response.json();
    renderAiSections(textEl, result.sections);
  } catch (error) {
    console.error("Couldn't load AI insight:", error);
    // Fails quietly — the rest of the forecast page (the real
    // computed data) already rendered and works fine on its own.
    panel.hidden = true;
  }
}

function renderAiSections(textEl, sections) {
  textEl.innerHTML = "";

  const parts = [
    { key: "health", label: "Inventory Health" },
    { key: "urgent", label: "Urgent Action" },
    { key: "opportunity", label: "Opportunity" },
    { key: "slowStock", label: "Slow-Moving Stock" }
  ];

  parts.forEach(({ key, label }) => {
    const value = sections?.[key];
    if (!value) return;

    const block = document.createElement("div");
    block.className = "forecast-ai-panel__section";
    block.innerHTML = `
      <h4 class="forecast-ai-panel__section-label"></h4>
      <p class="forecast-ai-panel__section-text"></p>
    `;
    block.querySelector(".forecast-ai-panel__section-label").textContent = label;
    block.querySelector(".forecast-ai-panel__section-text").textContent = value;
    textEl.appendChild(block);
  });
}