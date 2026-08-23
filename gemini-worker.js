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
const GEMINI_MODEL = "gemini-1.5-flash";

// Only your own site is allowed to call this — blocks random other
// websites from using your Gemini quota via this endpoint.
const ALLOWED_ORIGIN = "https://capstoneproject-403.pages.dev";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
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

    const { fastMovers, restockRecommended, totalTracked } = body || {};
    if (!Array.isArray(fastMovers) || !Array.isArray(restockRecommended)) {
      return jsonResponse({ error: "Missing or malformed forecast data" }, 400);
    }

    const prompt = buildPrompt(fastMovers, restockRecommended, totalTracked);

    let geminiResponse;
    try {
      geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 200, temperature: 0.4 }
          })
        }
      );
    } catch (error) {
      return jsonResponse({ error: "Couldn't reach the AI service right now." }, 502);
    }

    if (!geminiResponse.ok) {
      return jsonResponse({ error: "The AI service returned an error." }, 502);
    }

    const data = await geminiResponse.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

    if (!text) {
      return jsonResponse({ error: "The AI service returned an empty response." }, 502);
    }

    return jsonResponse({ summary: text });
  }
};

function buildPrompt(fastMovers, restockRecommended, totalTracked) {
  const fastList = fastMovers
    .slice(0, 5)
    .map((p) => `${p.name} (~${p.velocity} units/day)`)
    .join(", ") || "none currently tracked";

  const restockList = restockRecommended
    .slice(0, 5)
    .map((p) => `${p.name} (${p.currentStock} left${p.daysUntilStockout != null ? `, ~${Math.round(p.daysUntilStockout)} days until stockout` : ""})`)
    .join(", ") || "none urgent right now";

  return `You are an inventory assistant for a small grocery store. Write a short, plain-English summary (2-3 sentences, no markdown, no bullet points) for the store admin based on this real data. Be direct and actionable.

Fast-moving products: ${fastList}
Products needing restock soon: ${restockList}
Total products with sales data: ${totalTracked}

Write the summary now.`;
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
