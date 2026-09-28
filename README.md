# Hado SEO — Cloudflare Worker Middleware

A thin Cloudflare Worker that runs **in front of your own site** and makes it
readable to search engines and AI crawlers — no DNS changes, no proxy cutover.
It pre-filters bot traffic with a cheap User-Agent check and asks the
[Hado SEO](https://hadoseo.com) render endpoint for prerendered HTML; humans
are served your app completely untouched.

Full guide: **[docs.hadoseo.com/integrations/cloudflare-worker](https://docs.hadoseo.com/integrations/cloudflare-worker)**

## How it works

Your Worker is a thin, untrusted client. All the heavy lifting —
authentication, domain authorization, authoritative bot verification, caching,
and rendering — lives in the Hado SEO service. The Worker only has to:

1. Decide if a request *looks* like a bot (a loose User-Agent check —
   over-matching is harmless, Hado SEO re-verifies every bot authoritatively
   against published crawler IP ranges).
2. For bots, `GET` the render endpoint with the original URL, User-Agent, and
   visitor IP.
3. Serve the HTML on `200`, or serve your app normally on `204` (passthrough).

It also fires a fire-and-forget beacon for human visits arriving from AI
assistants (ChatGPT, Perplexity, Claude, …) so they show up in your AI-referral
analytics. No visitor IP is ever sent on that path.

## Prerequisites

- Your domain is on **Cloudflare** (active zone serving your traffic).
- **Node 18+** for the `wrangler` CLI.
- A Hado SEO account with your domain added via the **Cloudflare Worker**
  onboarding path, and an API key (`hado_sk_...`) — sign up at
  [hadoseo.com/auth](https://hadoseo.com/auth).

## Get the code

```bash
git clone https://github.com/hado-seo/hado-cloudflare-worker.git my-site-seo-proxy
cd my-site-seo-proxy
npm install
```

Then **edit `wrangler.toml`**:

- Replace `example.com` with your domain in both route `pattern`s and
  `zone_name`. Include every hostname that serves pages (`www.` too, if it
  serves traffic).
- Optionally change `name` — that's the Worker's name in your Cloudflare
  account.

## Deploy

### 1. Authenticate the Wrangler CLI (first time only)

```bash
npx wrangler login
```

This opens a browser window to authorize the CLI against your Cloudflare
account — the account that owns your domain's zone.

### 2. Set your API key as a secret

```bash
npx wrangler secret put HADO_API_KEY   # paste hado_sk_... when prompted
```

The key must be a **secret**, never a `[vars]` entry — vars are visible in the
Cloudflare dashboard and in `wrangler.toml`. Secrets persist across deploys;
you only set this once (re-run the same command to rotate the key).

### 3. Deploy

```bash
npx wrangler deploy
```

Deploying uploads the Worker and attaches the routes: from this moment every
request to your domain passes through it. Humans are unaffected (one header
check, then your app) — there is no cutover moment to schedule, and no DNS
change to wait on.

### 4. Verify

```bash
# 1. Humans still get your app untouched.
curl -sI https://example.com/ | head -3

# 2. A bot UA gets prerendered HTML. The FIRST hit of a page may return
#    your app shell (the render finishes in the background); run it twice.
curl -s -A "GPTBot/1.0" https://example.com/ | head -40
curl -s -A "GPTBot/1.0" https://example.com/ | head -40   # → full HTML
```

Then open your Hado SEO dashboard → **Analytics**: the test crawls appear
within a few minutes.

### Updating

Pull the latest template and redeploy — routes, vars, and your secret are
unchanged by a redeploy:

```bash
git pull && npm install && npx wrangler deploy
```

### Watching it run

```bash
npm run tail        # live request logs (wrangler tail)
```

### Rolling back

Each deploy creates a new version. If something looks wrong:

```bash
npx wrangler rollback   # revert to the previously deployed version
```

Or just remove the routes in the Cloudflare dashboard — traffic then flows
straight to your app again, exactly as before the Worker existed.

### Uninstalling

```bash
npx wrangler delete
```

Deleting the Worker detaches its routes. Your site keeps serving as it did
before — the Worker never sits between your DNS and your app, so there is
nothing to migrate back.

### Deploying from CI (optional)

To deploy on every push instead of from your laptop, add a Cloudflare API
token (dashboard → **My Profile → API Tokens**, "Edit Cloudflare Workers"
template) to your repo's secrets as `CLOUDFLARE_API_TOKEN`, then:

```yaml .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

`HADO_API_KEY` stays where it is — it's a Worker secret in Cloudflare, not a
repo secret, and deploys never touch it.

## What the Worker sends

`GET https://serve.hadoseo.com/v1/render?url=<absolute request URL>` with:

| Header | Required | Purpose |
|---|---|---|
| `Authorization: Bearer <key>` | ✅ | Your API key (or `x-api-key: <key>`). |
| `user-agent` | ✅ | The **original** bot UA — Hado verifies it. |
| `x-hadoseo-client-ip` | ✅ | The **original** visitor IP (copied from `cf-connecting-ip`). It must travel in this dedicated header: on a worker-to-worker hop the transport-level `cf-connecting-ip` is rewritten to your Worker's own egress IP, and real crawlers would look spoofed. |
| `x-hadoseo-mode: passthrough` | — | Optional. Analytics-only mode (see below). |

> **Never** send your Worker's own User-Agent or IP. Hado SEO verifies bots by
> matching the UA against published crawler IP ranges — if the IP that arrives
> is your Worker's egress, real crawlers will be rejected as spoofed and served
> a `204`.

## How to handle the response

| Status | Meaning | What the Worker does |
|---|---|---|
| `200` | Prerendered HTML (cache hit, or a fresh render). | Return the body to the bot. |
| `204` | Passthrough — not a verified bot, over quota, or a render that wasn't ready in time. | Serve your app: `fetch(request)`. |
| `400` | Missing/invalid `url`. | Fall through; check the URL you send. |
| `401` | Missing/invalid API key. | Fall through; fix your key/secret. |
| `403` | The URL's host isn't owned by your key's account. | Fall through; add the domain in your dashboard. |
| `429` | Rate limit exceeded. | Fall through; retry later or upgrade your plan. |

The service **fails open**: on any internal error or timeout it returns `204`
rather than a `5xx`, so your site never breaks. The Worker mirrors that —
anything that isn't a `200` falls through to `fetch(request)`.

## Analytics-only (passthrough mode)

Only want crawl and AI-agent analytics, without serving prerendered HTML?
Uncomment the `x-hadoseo-mode: passthrough` header in `src/worker.js`. Hado SEO
records who crawled what and returns `204`, so your app is always served as-is.
Passthrough never renders, so it uses no render quota — only your per-minute
rate limit applies.

## Local development

```bash
cp .dev.vars.example .dev.vars   # then paste your real key into .dev.vars
npm run dev
```

`.dev.vars` is gitignored; in production the key lives in a Wrangler secret.

## License

[MIT](LICENSE)
