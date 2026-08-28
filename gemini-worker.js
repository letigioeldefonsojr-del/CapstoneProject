// ====================================================================
// GEMINI FORECAST INSIGHT — Cloudflare Worker
// ----------------------------------------------------------------
// Does the same job as the Firebase Cloud Function version, on
// infrastructure you already have (Cloudflare) instead of requiring
// Firebase's Blaze plan and its payment-method verification.
//
// The Gemini API key is stored as a Worker SECRET (set via the
// Cloudflare dashboard or `wrangler secret put`) — it never appears
// in this file or anywhere the browser can see it.
//
// HONEST TRADEOFF vs the Firebase Function version: this doesn't
// verify the caller is a signed-in Firebase user (that would need
// JWT verification logic, more setup). It's still far more secure
// than putting the key in client JS — the key stays hidden either
// way — but it's a slightly lower bar than the Firebase version.
// Reasonable for a capstone's actual usage scale; worth tightening
// later if this becomes a real production concern.
// ====================================================================
const GEMINI_MODEL = "gemini-2.5-flash"; // confirmed live/stable via ListModels on 2026-08-23

// Only your own site is allowed to call this — blocks random other
// websites from using your Gemini quota via this endpoint.
const ALLOWED_ORIGIN = "https://capstoneproject-403.pages.dev";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method === "GET") {
      // Bare visits (e.g. typing the URL directly) just confirm the
      // Worker is alive and reachable — the real work only happens on
      // POST, which is what Forecast.js actually sends.
      return jsonResponse({ status: "Worker is running. Send a POST request to get an AI insight." });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch (error) {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const { fastMovers, moderateMovers, slowMovers, restockRecommended, totalTracked, noDataCount } = body || {};
    if (!Array.isArray(fastMovers) || !Array.isArray(restockRecommended)) {
      return jsonResponse({ error: "Missing or malformed forecast data" }, 400);
    }

    const prompt = buildPrompt(fastMovers, moderateMovers, slowMovers, restockRecommended, totalTracked, noDataCount);

    let geminiResponse;
    try {
      geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              maxOutputTokens: 700,
              temperature: 0.4,
              thinkingConfig: { thinkingBudget: 0 },
              responseMimeType: "application/json",
              responseSchema: {
                type: "object",
                properties: {
                  health: { type: "string" },
                  urgent: { type: "string" },
                  opportunity: { type: "string" },
                  slowStock: { type: "string" }
                },
                required: ["health", "urgent", "opportunity", "slowStock"]
              }
            }
          })
        }
      );
    } catch (error) {
      return jsonResponse({ error: "Couldn't reach the AI service right now." }, 502);
    }

    if (!geminiResponse.ok) {
      const errorBody = await geminiResponse.text();
      return jsonResponse({ error: "The AI service returned an error.", detail: errorBody, status: geminiResponse.status }, 502);
    }

    const data = await geminiResponse.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!text) {
      return jsonResponse({ error: "The AI service returned an empty response." }, 502);
    }

    let sections;
    try {
      sections = JSON.parse(text);
    } catch (error) {
      return jsonResponse({ error: "The AI service returned malformed structured output.", detail: text }, 502);
    }

    return jsonResponse({ sections });
  }
};

function buildPrompt(fastMovers, moderateMovers, slowMovers, restockRecommended, totalTracked, noDataCount) {
  const fastList = (fastMovers || [])
    .map((p) => `${p.name} (~${p.velocity} units/day, ${p.currentStock} in stock)`)
    .join(", ") || "none currently tracked";

  const moderateList = (moderateMovers || [])
    .map((p) => `${p.name} (~${p.velocity} units/day)`)
    .join(", ") || "none";

  const slowList = (slowMovers || [])
    .map((p) => `${p.name} (~${p.velocity} units/day, ${p.currentStock} in stock)`)
    .join(", ") || "none currently tracked";

  const restockList = (restockRecommended || [])
    .map((p) => `${p.name} (${p.currentStock} left${p.daysUntilStockout != null ? `, ~${Math.round(p.daysUntilStockout)} days until stockout` : ""}, ${p.velocityTier}-moving)`)
    .join(", ") || "none urgent right now";

  return `You are an inventory analyst for a small grocery store. Based on the real data below, write a genuinely useful, structured analysis for the store admin.

Fast-moving products (best sellers): ${fastList}
Moderate-moving products: ${moderateList}
Slow-moving products (at risk of becoming dead stock): ${slowList}
Products needing restock soon, sorted by urgency: ${restockList}
Total products with enough sales history to analyze: ${totalTracked}
Products with no sales data yet (can't be analyzed): ${noDataCount ?? "unknown"}

Fill in each field with 1-2 plain-English sentences, no markdown, being specific and naming actual products from the data:
- health: a direct read on overall inventory health right now
- urgent: what needs restocking soonest and why, naming specific products
- opportunity: what's selling well that the store should keep in stock or lean into
- slowStock: name anything at risk of becoming dead stock and suggest a concrete next step (a promotion, bundling, reducing future restock quantity) — or say plainly if nothing looks concerning here`;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}
