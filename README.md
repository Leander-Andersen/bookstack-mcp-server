# BookStack MCP Server

Connect your [BookStack](https://www.bookstackapp.com/) knowledge base to Claude via the Model Context Protocol (MCP). Runs as a Cloudflare Worker — no server to maintain, auto-deploys from GitHub on every push.

**56 tools** covering every BookStack API endpoint: books, pages, chapters, shelves, users, roles, search, attachments, images, permissions, recycle bin, audit log, and system info.

---

## Setup Guide

### What you need before starting

- A GitHub account (to host the code)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is fine)
- A running BookStack instance you can log into
- Claude.ai (Pro or higher, for MCP support)

---

### Step 1 — Fork the repository

Go to this repository on GitHub and click **Fork** (top right). This gives you your own copy of the code that Cloudflare will deploy from.

---

### Step 2 — Connect to Cloudflare Workers

1. Log into [dash.cloudflare.com](https://dash.cloudflare.com)
2. Go to **Workers & Pages** in the left sidebar
3. Click **Create** → **Import a repository**
4. Connect your GitHub account and select your forked repository
5. Set the build settings:
   - **Framework preset**: None
   - **Build command**: `npm install`
   - **Deploy command**: `npx wrangler deploy`
6. Click **Save and Deploy**

Cloudflare will now automatically redeploy every time you push to `main`.

> Your worker URL will be something like `https://bookstack-mcp-server.<your-subdomain>.workers.dev`

---

### Step 3 — Set the secrets

In the Cloudflare dashboard, go to your worker → **Settings** → **Variables and Secrets**. Add these three secrets (use **Secret** type, not plain text):

| Secret name | What to put | Where to find it |
|---|---|---|
| `BOOKSTACK_BASE_URL` | Your BookStack API URL | Your BookStack domain + `/api`, e.g. `https://bookstack.example.com/api` |
| `BOOKSTACK_API_TOKEN` | Your BookStack API token | See below |
| `MCP_API_KEY` | A password you invent | Any long random string — this is what you'll type into Claude to connect |

**Finding your BookStack API token:**
1. Log into BookStack
2. Click your profile picture → **Edit Profile**
3. Scroll to **API Tokens** → **Create Token**
4. Copy the **Token ID** and **Token Secret**
5. Combine them as: `tokenID:tokenSecret` (with a colon in the middle)

After saving the secrets, trigger a new deploy (push any change to GitHub, or click **Retry deployment** in the CF dashboard).

---

### Step 4 — Connect Claude.ai

1. Go to [claude.ai](https://claude.ai) → click your profile → **Settings** → **Integrations**
2. Click **Add integration**
3. Enter your worker URL with `/mcp` at the end:
   ```
   https://bookstack-mcp-server.<your-subdomain>.workers.dev/mcp
   ```
4. Claude will open a login page — enter your `MCP_API_KEY` as the password
5. Click **Allow** — you're connected

Claude now has access to all 56 BookStack tools.

---

### Checking it works

Ask Claude something like:

> "List my BookStack books"

or

> "Search my BookStack for pages tagged 'personal'"

You can also hit the health endpoint in your browser:
```
https://bookstack-mcp-server.<your-subdomain>.workers.dev/health
```
It should return `{"status":"ok"}`.

---

## Technical Reference

### Architecture

The server runs as a stateless Cloudflare Worker. Each request spins up a fresh MCP server instance — there is no persistent state between calls.

```
Claude.ai  ──OAuth 2.0 PKCE──>  /oauth/authorize  (password login page)
                                 /oauth/token       (code → bearer token)
Claude.ai  ──Bearer token──>    /mcp               (MCP JSON-RPC)
```

Authentication uses OAuth 2.0 Authorization Code + PKCE (RFC 7636). Tokens are stateless HMAC-SHA256 JWTs signed with `MCP_API_KEY` via the Web Crypto API — no database or KV store needed.

### Endpoints

| Path | Method | Auth | Purpose |
|---|---|---|---|
| `/health` | GET | None | Health check |
| `/.well-known/oauth-authorization-server` | GET | None | OAuth discovery (RFC 8414) |
| `/.well-known/oauth-protected-resource` | GET | None | Resource metadata (RFC 9728) |
| `/oauth/authorize` | GET / POST | None | Login page / submit password |
| `/oauth/token` | POST | None | Exchange auth code for bearer token |
| `/mcp` | GET / POST / DELETE | Bearer token | MCP StreamableHTTP transport |

### Secrets reference

| Name | Required | Description |
|---|---|---|
| `BOOKSTACK_BASE_URL` | Yes | BookStack API base, e.g. `https://bookstack.example.com/api` |
| `BOOKSTACK_API_TOKEN` | Yes | BookStack API token as `tokenID:tokenSecret` |
| `MCP_API_KEY` | Yes | Shared secret used as the OAuth password and token signing key |

Optional `[vars]` in `wrangler.toml` (non-secret):

| Name | Default | Description |
|---|---|---|
| `SERVER_NAME` | `bookstack-mcp-server` | Server name reported in MCP metadata |
| `SERVER_VERSION` | `1.2.5` | Version string sent in `X-MCP-Server-Version` header |

### BookStack API token format

BookStack API tokens consist of two parts: a **Token ID** and a **Token Secret**, generated under your profile → API Tokens. They are combined with a colon:

```
BOOKSTACK_API_TOKEN=abc123:xyz789secret
```

The token is sent to BookStack as `Authorization: Token abc123:xyz789secret`.

### Notable implementation details

**Express shim** — The MCP SDK's `StreamableHTTPServerTransport` expects Express-style `req`/`res` objects. The worker shims these: POST responses wait for the transport's async `res.end()` call, while GET (SSE) responses resolve immediately after `handleRequest()` returns since the transport never calls `end()` for SSE streams.

**Audit log date filtering** — BookStack's `/api/audit-log` endpoint does not support date range filtering via query params. When `date_from` or `date_to` is specified, the worker fetches all matching entries via paginated `fetchAll()` and filters by `created_at` client-side.

**Tag-only search** — BookStack's search API supports filter-only queries such as `{tag:name=value}` without a text term. Empty-query tag searches build the query from filter operators alone.

**Partial name matching** — BookStack's `filter[name]` only supports exact matches. The `bookstack_books_list` and `bookstack_shelves_list` tools use `fetchAll()` to retrieve all items and apply a case-insensitive `includes()` match locally.

**Pagination** — `fetchAll()` fetches the first page (500 items), reads the `total` field, then fires all remaining pages in parallel.

### Deploying updates

Push to `main`. Cloudflare's GitHub integration deploys automatically — no manual `wrangler deploy` needed. The `X-MCP-Server-Version` response header shows which version is live.

```bash
git add .
git commit -m "your change"
git push origin main
```

### Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in your secrets
npx wrangler dev                  # runs on http://localhost:8787
```

`.dev.vars` format:
```
BOOKSTACK_BASE_URL=https://bookstack.example.com/api
BOOKSTACK_API_TOKEN=tokenID:tokenSecret
MCP_API_KEY=any-string-you-choose
```

### Wrangler tail (live logs)

```bash
npx wrangler tail bookstack-mcp-server --format=pretty
```

---

## License

MIT — see [LICENSE](LICENSE) for details.
