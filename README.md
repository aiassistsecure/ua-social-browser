<div align="center">

# UA Social Browser

**A desktop browser where an AI drafts your posts and you sign them — then they leave through your own account, in your own session.**

`X` · `Instagram` · `Facebook` · `Threads` · `LinkedIn` · `Bluesky` · `Mastodon` · `Reddit` · `TikTok` · `YouTube` · `Pinterest` · `Tumblr`

</div>

---

## The idea

Most "AI social tools" are autopilots. You hand over your credentials, and something posts on your behalf while you hope it stays tasteful.

This one is built the other way around. The model **drafts, rewrites, shortens, and plans**. A person **approves**. And then the post leaves through the browser session *you* are already signed into — not through a server holding an API token that acts as you.

Three rules the codebase actually enforces:

1. **No approval, no post.** The publish endpoint rejects anything without a human sign-off attached. Edit an approved draft and the approval is cleared, because the sign-off was on that exact text.
2. **No fake success.** With no desktop shell attached, publishing returns `503` and the draft is marked `failed` with the reason. It never says "published" about something that never left the machine.
3. **No impersonation.** There is no server-side posting path at all. If your session isn't signed in, nothing goes out.

What it is not, and will not become: a bulk poster, a scraper, an engagement farm, a CAPTCHA bypass, or a stealth automation kit.

## How it fits together

```
┌─────────────────────────────────────────────────────────────┐
│  ua-shell  (Electron desktop browser)                       │
│                                                             │
│  ┌───────────────────┐   ┌───────────────────────────────┐  │
│  │  Workspace view   │   │  Sidebar (privileged page)    │  │
│  │  x.com, signed in │   │  drafts · approvals · AI      │  │
│  │  isolated session │   │  window.uaShell injected here │  │
│  └───────────────────┘   └───────────────────────────────┘  │
│           │                            │                    │
│           └──── session bridge ────────┼──── loopback ───┐  │
└─────────────────────────────────────────────────────────┼──┘
                                                          │
                        ┌─────────────────────────────────▼──┐
                        │  api-server                        │
                        │  approvals · scheduler · AI proxy  │
                        │  append-only ledger (nedb-engine)  │
                        └────────────────────────────────────┘
```

Each workspace is a separate browsing identity: its own cookie jar, its own profile directory, its own User-Agent and Client Hints, its own timezone. Workspaces cannot see each other's sessions, and the active identity is always visible in the toolbar — you should never be unsure which account you are about to post from.

The sidebar is a privileged page with `window.uaShell` injected. Page content loaded inside a workspace never receives it, so a social network cannot reach your ledger, your profiles, or the publisher.

## Repository map

| Path | What lives there |
| --- | --- |
| `desktop/ua-shell` | The Electron shell: workspace contexts, UA metadata, toolbar, publisher adapters, session-bridge server |
| `artifacts/ua-social-browser` | The sidebar UI — network view, AI composer, review queue, calendar, UA profiles |
| `artifacts/api-server` | Approvals, the scheduler, the AI proxy, and the append-only ledger |
| `lib/api-spec` | The OpenAPI contract — the single source of truth |
| `lib/api-client-react`, `lib/api-zod` | Generated client hooks and validators. **Never edit by hand** |

The contract comes first: change `lib/api-spec/openapi.yaml`, run codegen, and both sides move together.

## Quick start

```bash
pnpm install
pnpm --filter @workspace/api-spec run codegen   # after any OpenAPI change
pnpm run typecheck                              # libs + every artifact + the shell
```

Run the web development surface (the sidebar UI and API, without the browser around them):

```bash
pnpm --filter @workspace/api-server run dev
pnpm --filter @workspace/ua-social-browser run dev
```

Run the real thing:

```bash
pnpm --filter @workspace/ua-shell run start
```

You need `AIASSIST_API_KEY` for the AI features. Copy `.env.example` and fill it in — the key is read only by the API server and never reaches a renderer process.

## Trying it without the desktop shell

The web surface is a development surface, and it is honest about its limits:

- The **network view** shows an explicit "runs in the desktop shell" state instead of a mocked feed. X and the others send frame-blocking headers, and a fake feed that looks right but means nothing is worse than no feed.
- **Publishing returns 503.** There is no session to post through, so it says so.

Everything else — drafting, approving, scheduling, the ledger, integrity checks — works there.

## The ledger

State is a single append-only `nedb-engine` ledger, scoped by tenant id. Nothing is overwritten in place; you can verify the chain and export the whole history:

```bash
curl localhost:8080/api/browser/integrity   # verified, sequence, head
curl localhost:8080/api/browser/export      # full state + integrity record
```

The app ships **single-tenant** — one person, one machine. Every document is still written under a tenant key, so multi-tenant is a change of resolver, not a migration. Set `UA_TENANCY_MODE=multi` and an auth layer must supply the tenant; there is deliberately no fallback, because a silent one would leak one account's workspaces into another's.

## Networks

Each network carries its own character limit, media rules, thread support, alt-text support, and feed/compose URLs. They live in `artifacts/ua-social-browser/src/lib/platforms.ts`, with matching publisher adapters in `desktop/ua-shell/src/publisher/adapters.ts`.

Adding one means: an entry in the platform registry, an adapter in the shell, the `platform` enum in `lib/api-spec/openapi.yaml`, then codegen.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `AIASSIST_API_KEY` | — | Credential for the AI provider. Server-side only. |
| `PORT` | `8080` | Assigned by the host. Never hard-code it. |
| `NEDB_DATA_DIR` | `<cwd>/.data/ua-social-browser` | Ledger location. Back this up — it is the app's memory. |
| `UA_SESSION_BRIDGE_URL` | unset | Loopback address of the shell's publisher. Unset disables publishing. |
| `UA_TENANCY_MODE` | `single` | `single` or `multi`. |

Full deployment and packaging notes, including the session-bridge HTTP contract, are in [DEPLOY.md](./DEPLOY.md).

## Status

Working: workspace isolation, UA profiles, the AI composer, the approval gate, scheduled dispatch, the ledger, and the twelve platform adapters.

Not there yet: signed installers for each OS, and per-tab UA switching (it is per-workspace today).

## License

GNU General Public License v3.0 or later — see [LICENSE](./LICENSE).

If you distribute a modified version of this browser, your changes have to stay
free software too. That is deliberate: a tool whose whole premise is that a
person stays in control of what gets posted should not be quietly forked into
an autopilot behind a closed door.
