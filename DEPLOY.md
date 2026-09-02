# Deploying UA Social Browser

This project has two halves that ship on different tracks:

| Half | What it is | Where it runs |
| --- | --- | --- |
| **Workspace surface** (`artifacts/ua-social-browser`, `artifacts/api-server`) | The sidebar UI, the AI endpoints, the review queue, the ledger | Replit today; embedded in the desktop shell in production |
| **Native shell** | A Chromium fork with per-workspace session isolation, UA profiles, and the session bridge | Built and signed on your own machines |

The Replit artifact is the **development surface** for the shared UI and API. It is
not the shipped product, and it deliberately cannot post to any network — see
[Why publishing fails on the web surface](#why-publishing-fails-on-the-web-surface).

---

## 1. Prerequisites

- Node 24 and pnpm (already provisioned in the Replit container)
- `AIAssIST_API_KEY` — set as a Replit Secret; it never leaves the API server
- For the native shell: `depot_tools`, ~100 GB free disk, 16 GB+ RAM

## 2. Environment variables

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `AIAssIST_API_KEY` | yes | — | Credential for `api.AiAssist.net`. Server-side only. |
| `PORT` | injected | `8080` | Assigned per artifact by Replit. Never hard-code it. |
| `NEDB_DATA_DIR` | no | `<cwd>/.data/ua-social-browser` | Append-only ledger location. Point it at a persistent volume in the desktop build. |
| `UA_SESSION_BRIDGE_URL` | no | unset | Loopback address of the native shell's publisher IPC endpoint. **Unset means publishing is disabled.** |
| `UA_TENANCY_MODE` | no | `single` | `single` scopes every document to the `personal` tenant. `multi` requires an auth layer to set `res.locals.tenantId` and returns 401 without one. |

## 3. Running the workspace surface

```bash
pnpm install
pnpm --filter @workspace/api-spec run codegen   # after any OpenAPI change
pnpm run typecheck                              # libs + all artifacts
```

Both services run as Replit workflows and restart on their own:

- `artifacts/api-server: API Server` → `http://localhost:8080`, mounted at `/api`
- `artifacts/ua-social-browser: web` → the Vite dev server, preview path `/`

Smoke test the API:

```bash
curl -s localhost:8080/api/healthz
curl -s localhost:8080/api/tenant
curl -s localhost:8080/api/browser/integrity
curl -s "localhost:8080/api/session/status?workspaceId=ws-1"
```

## 4. Publishing the web surface on Replit

Use the workspace's Publish flow (Autoscale). It deploys the sidebar UI and the
API server. Set `AIAssIST_API_KEY` in the deployment's secrets — deployment
secrets are separate from development secrets. Leave `UA_SESSION_BRIDGE_URL`
unset in that environment.

The ledger writes to local disk, so an Autoscale deployment treats its store as
ephemeral. Anything you want to keep lives on the desktop build.

## 5. Building the native shell

```bash
# one-time
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git
export PATH="$PATH:/path/to/depot_tools"
mkdir chromium && cd chromium
fetch --nohooks chromium && cd src
./build/install-build-deps.sh
gclient runhooks
```

Apply the workspace patches, then:

```bash
gn gen out/Release --args='is_debug=false is_official_build=true symbol_level=0 enable_nacl=false blink_symbol_level=0'
autoninja -C out/Release chrome
```

### What the patches must provide

1. **Workspace isolation** — one `BrowserContext` per workspace, backed by its own
   on-disk profile directory and cookie jar (`persist:ua-<workspaceId>`). No
   sharing of storage, service workers, or cache between workspaces.
2. **UA profile application** — per-context `User-Agent`, `Accept-Language`,
   timezone override, and Client Hints (`Sec-CH-UA*`) that agree with the UA
   string. A mismatched pair is more identifying than no override at all.
3. **Toolbar indicator** — the active workspace name and UA profile stay visible
   in the browser chrome. The operator must always know which identity is live.
4. **Privileged sidebar** — the workspace UI loads as a WebUI page with
   `window.uaShell` injected. Ordinary page content never receives that object.
5. **Publisher IPC** — the endpoint described below, bound to loopback, that the
   API server reaches through `UA_SESSION_BRIDGE_URL`.

### `window.uaShell` (renderer contract)

Typed in `artifacts/ua-social-browser/src/lib/shell-bridge.ts`:

- `attachSurface(container, options)` — mounts a workspace-isolated Chromium view
- `openInWorkspaceTab(workspaceId, url)` — opens a normal tab in that workspace
- `getSessionStatus(workspaceId)` — reports whether that session is signed in

### Session bridge (HTTP contract)

The shell listens on loopback; the API server calls it. Consumed by
`artifacts/api-server/src/lib/session-bridge.ts`.

```
GET /session/:workspaceId
  200 { authenticated: boolean, accountHandle?: string, detail?: string }

POST /publish
  body { workspaceId, draftId, platform, body, idempotencyKey }
  200      { postUrl?: string, postId?: string }
  401/403  { detail: string }   → surfaced as "session not signed in"
  4xx/5xx  { detail: string }   → surfaced as "the platform rejected the post"
```

`idempotencyKey` is derived from the draft id plus its approval timestamp, so a
retry after a network stall cannot double-post.

## 6. Why publishing fails on the web surface

Posts leave through **your own signed-in browser session**, never through a
server-held token. With no shell attached, `POST /api/publish` answers `503` and
the draft is marked `failed` with the reason attached. That is the intended
behaviour: a silent success would be a lie about whether something reached an
audience.

## 7. Networks

X is the primary network. Also configured: Instagram, Facebook, Threads,
LinkedIn, Bluesky, Mastodon, Reddit, TikTok, YouTube, Pinterest, Tumblr. Each
carries its own character limit, media rules, thread support, and feed/compose
URLs in `artifacts/ua-social-browser/src/lib/platforms.ts`. Adding a network
means adding an entry there and to the `platform` enum in
`lib/api-spec/openapi.yaml`, then re-running codegen.

Live network views render only inside the native shell. X, Instagram, and the
rest send frame-blocking headers, so the web surface shows an explicit "runs in
the desktop shell" state and an open-in-tab link rather than a fake feed.

## 8. Data and integrity

State is a single append-only `nedb-engine` ledger, scoped by tenant id.
`GET /api/browser/integrity` returns `verified`, `sequence`, and `head`;
`GET /api/browser/export` downloads the full state with its integrity record.
Back up `NEDB_DATA_DIR` — that directory is the product's memory.

`nedb-engine` loads a prebuilt `.node` binding relative to its own directory, so
it is marked external in `artifacts/api-server/build.mjs`. Bundling it produces
`Cannot find module 'nedb-engine-linux-x64-gnu'` at startup.

## 9. Release checklist

- [ ] `pnpm run typecheck` clean
- [ ] `pnpm --filter @workspace/api-spec run codegen` re-run after any spec edit
- [ ] `AIAssIST_API_KEY` present in the target environment
- [ ] `UA_SESSION_BRIDGE_URL` set in desktop builds, unset elsewhere
- [ ] Approve → post round-trip verified against one real account per network
- [ ] Approval revocation verified: editing an approved draft clears the sign-off
- [ ] `NEDB_DATA_DIR` backed up
