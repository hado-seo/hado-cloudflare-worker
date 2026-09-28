// A loose pre-filter derived from Hado's bot registry and known-good crawler
// list. Hado SEO re-verifies bots authoritatively, so a false positive only
// costs one subrequest — but every token here must be BOT-specific: a token
// that also appears in human in-app-browser UAs (e.g. "pinterest",
// "snapchat") would make real visitors wait on the render call.
const BOT_UA = new RegExp(
  [
    // Search engines
    "googlebot|googleother|storebot-google|google-inspectiontool|adsbot-google",
    "adidxbot|mediapartners|apis-google|feedfetcher-google|google-read-aloud",
    "bingbot|yandex|baiduspider|duckduckbot|slurp|seznambot|sogou|exabot",
    "petalbot|seekport|bravebot|applebot|amazonbot",
    // AI crawlers, assistants, and user-initiated agent fetches
    "gptbot|oai-searchbot|chatgpt-user|chatgpt-agent",
    "claudebot|claude-user|claude-searchbot|anthropic-ai",
    "perplexitybot|perplexity-user|mistralai-user|duckassistbot|amzn-user",
    "google-extended|google-cloudvertexbot|google-notebooklm",
    "gemini-deep-research|googleagent-mariner|meta-externalfetcher",
    "ccbot|bytespider|tiktokspider|youbot|cohere|diffbot|omgili|ai2bot",
    "timpibot|tavilybot",
    // Social & messaging link previews
    "facebookexternalhit|facebookbot|facebot|meta-externalagent|twitterbot",
    "linkedinbot|pinterestbot|slackbot|slack-imgproxy|discordbot|whatsapp",
    "telegrambot|redditbot|quora-bot|bitlybot|skypeuripreview",
    "googlemessages|google-chat-link-preview|bufferlinkpreviewbot",
    "metadatascraper",
    // SEO & monitoring tools
    "ahrefsbot|semrushbot|siteauditbot|dataforseobot|rsiteauditor|sebot-wa",
    "screaming frog|mj12bot|dotbot|rogerbot|blexbot|barkrowler|serpstatbot",
    "seokicks|gtmetrix|uptimebot|ia_archiver|archive\\.org_bot",
  ].join("|"),
  "i",
);

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

      // 200 → prerendered HTML; 404 → a soft-404 snapshot (the app renders
      // "not found" content for this route). Serve BOTH with their real
      // status — swallowing the 404 would show crawlers a 200 for a page
      // that doesn't exist (a soft-404 penalty). 404 is safe to pass
      // through: Hado's caller errors are only ever 400/401/403/429.
      if (res.status === 200 || res.status === 404) {
        return new Response(res.body, {
          status: res.status,
          headers: {
            "content-type": "text/html; charset=utf-8",
            // Reuse Hado's cache directives so your edge can cache repeat hits.
            "cache-control":
              res.headers.get("cache-control") || "public, max-age=0",
          },
        });
      }

      // 301/302/307/308 → a routing rule configured in the Hado dashboard.
      // Return the redirect to the bot verbatim.
      const location = res.headers.get("location");
      if (res.status >= 301 && res.status <= 308 && location) {
        return new Response(null, { status: res.status, headers: { location } });
      }

      // A blocked path's noindex/nofollow directives ride the 204 —
      // copy them onto the app's response as X-Robots-Tag.
      const robots = res.headers.get("x-hadoseo-robots");
      if (robots) {
        const originRes = await fetch(request);
        const withRobots = new Response(originRes.body, originRes);
        withRobots.headers.set("x-robots-tag", robots);
        return withRobots;
      }

      // Plain 204 (human/spoofed/over-limit) or any 4xx → the app, untouched.
    } catch (err) {
      // Network error or timeout → fail open.
    }

    return fetch(request);
  },
};
