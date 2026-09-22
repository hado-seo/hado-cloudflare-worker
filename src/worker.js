// A loose pre-filter. Hado SEO re-verifies bots authoritatively, so this only
// needs to catch likely crawlers — over-matching is harmless.
const BOT_UA =
  /(googlebot|bingbot|yandex|duckduckbot|baiduspider|slurp|applebot|gptbot|oai-searchbot|chatgpt-user|perplexitybot|claudebot|anthropic-ai|ccbot|google-extended|bytespider|facebookexternalhit|twitterbot|linkedinbot|slackbot|discordbot|whatsapp|telegrambot|petalbot|amazonbot|semrushbot|ahrefsbot)/i;

// How long to wait for a cold render before giving up and serving your app.
const RENDER_TIMEOUT_MS = 15000;

export default {
  async fetch(request, env, ctx) {
    const ua = request.headers.get("user-agent") || "";
    const isBot = BOT_UA.test(ua);

    // Humans: record AI referrals (ChatGPT, Perplexity, …) with a
    // fire-and-forget beacon, then serve your app untouched.
    if (request.method === "GET" && !isBot) {
      const referer = request.headers.get("referer");
      const dest = request.headers.get("sec-fetch-dest") || "document";
      if (referer && dest === "document") {
        ctx.waitUntil(
          fetch(new URL("/v1/event/referral", env.HADO_RENDER_ENDPOINT), {
            method: "POST",
            headers: {
              authorization: `Bearer ${env.HADO_API_KEY}`,
              "content-type": "application/json",
              "user-agent": ua, // the ORIGINAL visitor UA
            },
            body: JSON.stringify({ url: request.url, referer }),
          }).catch(() => {}),
        );
      }
      return fetch(request);
    }

    // Only prerender bot GET navigations. Everything else → your app, untouched.
    if (request.method !== "GET") {
      return fetch(request);
    }

    try {
      const endpoint = new URL(env.HADO_RENDER_ENDPOINT);
      endpoint.searchParams.set("url", request.url);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);

      const res = await fetch(endpoint, {
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${env.HADO_API_KEY}`,
          // Forward the ORIGINAL bot identity so Hado can verify it.
          "user-agent": ua,
          // The visitor IP MUST travel in x-hadoseo-client-ip: on a
          // worker-to-worker hop, transport-level headers like
          // cf-connecting-ip are rewritten to YOUR Worker's egress IP,
          // and real crawlers would be rejected as spoofed.
          "x-hadoseo-client-ip": request.headers.get("cf-connecting-ip") || "",
          // Analytics-only? Uncomment to record the crawl without prerendering:
          // "x-hadoseo-mode": "passthrough",
        },
      }).finally(() => clearTimeout(timer));

      // 200 → prerendered HTML. Serve it to the bot.
      if (res.status === 200) {
        return new Response(res.body, {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            // Reuse Hado's cache directives so your edge can cache repeat hits.
            "cache-control":
              res.headers.get("cache-control") || "public, max-age=0",
          },
        });
      }

      // 204 (human/spoofed/over-limit) or any 4xx → fall through to your app.
    } catch (err) {
      // Network error or timeout → fail open.
    }

    return fetch(request);
  },
};
