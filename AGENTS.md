# AGENTS.md

Handoff notes for whoever picks this up next — human or agent. Read this before
touching anything. `README.md` is the pitch; `DEPLOY.md` is the operational
manual; this file is what a contributor needs in order not to break the thing
that makes the project worth having.

Repo: `https://github.com/ethgr0wth/ua-social-browser` (branch `main`, GPLv3).

---

## 1. What this is

A desktop browser for running social accounts, where **AI drafts, a human
approves, and the post goes out through the operator's own signed-in session**.

The one sentence that governs every design decision: *there is no server-held
token and no bot account anywhere in this system.* A post reaches an audience
because the person who owns the account was signed into it in this browser and
approved that text. If that chain cannot be completed, the app says so and
stops — it never posts by another route and never reports a post it did not
make.

Twelve networks are configured, X is primary. Single-tenant today, with a
tenant key on every stored document so multi-tenant is a resolver change rather
than a migration.

**The Replit repl is a development surface only.** It has no browser sessions,
so publishing there is impossible by construction; the API server says exactly
that instead of pretending. The product is the Electron shell, built and run on
the operator's own machine.

---

## 2. Invariants — do not "simplify" these

These are the load-bearing rules. Each exists because the alternative is a lie
told to someone about their own account.

1. **Publishing only happens through the shell's session bridge.** No server
   posting path, no stored credentials, no API tokens. If the bridge is not
   configured, publish endpoints refuse and explain.
2. **`published` requires the network's own confirmation.** Submitted-but-
   unconfirmed is its own outcome (`409`), is recorded as spent in the ledger,
   and is **never retried automatically** — an automatic retry there is how you
   double-post. A person looks at the account and decides.
3. **Approval is read from stored state, never asserted by the request.**
   Editing an approved draft clears the sign-off, which also makes it
   ineligible for scheduled dispatch.
4. **One idempotency key per instruction**, derived server-side from the draft
   id plus its approval timestamp. Callers may not supply one; the API refuses
   if they try.
5. **One automatic attempt per scheduled instruction.** Re-scheduling is a new
   instruction and earns one more attempt.
6. **One writer per document.** The browser state document belongs to the UI;
   the scheduler reports through the dispatch log instead of writing into it.
7. **Sessions are per workspace and never shared.** Partition key is
   `persist:ua-<sanitised id>-<digest of raw id>` — the digest exists because
   sanitising alone would collide `team/a` with `team-a`, which is a
   cross-account cookie leak.
8. **Page content gets no preload.** Workspace surfaces, workspace tabs, the
   sign-in tab, and the hidden publish window all run without `window.uaShell`.
   Only the privileged UI origin has it, and that origin is cookie-gated.
9. **The app never reads, fills, or stores credentials.** Sign-in is the human
   typing into the network's own page.
10. **No mock data, no silent fallbacks.** Unknown state is reported as unknown
    (Bluesky and Mastodon genuinely cannot be judged from cookies, and say so).

If a change requires weakening one of these, that is a conversation with the
owner, not a refactor.

---

## 3. Layout

```
artifacts/
  ua-social-browser/   React + Vite workspace UI (the sidebar app)
  api-server/          Express API: state, AI, scheduling, publish gateway
  mockup-sandbox/      Replit-only component preview surface; not part of the product
desktop/
  ua-shell/            Electron shell: the actual browser and the only publisher
lib/
  api-spec/            openapi.yaml — the contract, and the codegen entrypoint
  api-zod/             generated zod schemas (do not hand-edit)
  api-client-react/    generated react-query hooks (do not hand-edit)
  db/                  template leftover; declared as a dependency, never imported
scripts/               template leftover
.agents/memory/        durable notes for agents (see §12)
```

### The shell, file by file

| File | What it owns |
| --- | --- |
| `src/main.ts` | Startup order: publisher → bridge → API server → UI origin → window |
| `src/config.ts` | Env parsing, pairing rules for an external API server |
| `src/shell-window.ts` | `BaseWindow` + `WebContentsView`s: toolbar, privileged UI, surfaces, tabs |
| `src/workspace-contexts.ts`, `src/partition.ts` | Per-workspace sessions and their keys |
| `src/ua-metadata.ts` | UA string → headers, client hints, timezone (all derived, never invented) |
| `src/ui-server.ts`, `src/preload/` | The privileged loopback origin and its gate |
| `src/session-bridge-server.ts` | Loopback HTTP the API server calls; token-gated |
| `src/publisher/index.ts` | `sessionStatus`, `publish`, `beginSignIn` |
| `src/publisher/adapters.ts` | Per-network cookies, composer config, sign-in URL, refusal reasons |
| `src/publisher/compose-driver.ts` | The shared composer flow and its honesty rules |
| `src/idempotency.ts` | The spent-key ledger on disk |

### The API server

Routes (all under `/api`): `/healthz`, `/tenant`, `/browser/state` (GET/PUT),
`/browser/integrity`, `/browser/export`, `/ai/models`, `/ai/suggest`,
`/session/status`, `/session/signin`, `/publish`, `/schedule/status`,
`/schedule/dispatches`, `/schedule/outcomes`.

`src/lib/session-bridge.ts` is the only place that talks to the shell (20s
request timeout). `src/lib/scheduler.ts` runs the clock; `dispatch-claims.ts`
and `dispatch-log.ts` keep one attempt per instruction and keep the scheduler
out of the browser's document.

---

## 4. How the pieces talk

```
workspace UI  ──fetch /api/*──▶  API server  ──loopback + token──▶  shell publisher
     ▲                               │                                    │
     └────── window.uaShell ─────────┘                          workspace session
             (only in the shell)                                (cookies, UA profile)
```

- In the shell, the UI is served from a loopback origin that proxies `/api` to
  the API server, so the UI's relative fetches work unchanged in both places.
- On Replit the UI hits the API server artifact directly at `/api`.
- `window.uaShell` (typed in `artifacts/ua-social-browser/src/lib/shell-bridge.ts`)
  exists only inside the shell: `attachSurface`, `openInWorkspaceTab`,
  `getSessionStatus`. Web-surface code must degrade honestly when it is absent.

---

## 5. Running it

### On Replit (development)

Three workflows, already configured — restart them rather than inventing new ones:

- `artifacts/api-server: API Server`
- `artifacts/ua-social-browser: web`
- `artifacts/mockup-sandbox: Component Preview Server`

Both app services read `PORT` from the environment. The Vite config *throws* if
`PORT` or `BASE_PATH` is missing — that is deliberate, not a bug to patch out.

### On the operator's machine (the real thing)

```bash
pnpm install
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/ua-social-browser run build
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/ua-shell run start      # builds, then launches Electron
```

The shell mints its own bridge token and API access token at startup and passes
them to the API server it spawns. Nothing needs to be set by hand for the
default path.

### Checks

```bash
pnpm run typecheck                              # whole workspace
pnpm --filter @workspace/ua-shell run test      # 76 tests, no display needed
pnpm --filter @workspace/api-server run test    # 24 tests, scheduled dispatch
```

Both suites are fast and neither needs Electron or a browser. Run them before
you push; they have caught real bugs (a submit phase that ate the whole time
budget, a stale unconfirmed-outcome assumption).

---

## 6. The API contract and codegen

`lib/api-spec/openapi.yaml` is the source of truth. After editing it:

```bash
pnpm --filter @workspace/api-spec run codegen
```

This runs orval into `lib/api-zod` and `lib/api-client-react`, then typechecks
the libs. Never hand-edit generated files.

Naming: orval derives schema names from `operationId`, so `beginSignIn` gives
`BeginSignInBody` / `BeginSignInResponse`. **Give every request body a named
component schema** (`$ref: '#/components/schemas/SignInRequest'`) — an inline
body generates a type that collides with the zod export and fails codegen.

The publish, sign-in, AI, and health routes parse their request bodies — and in
places their own responses — with the generated zod schemas. Keep new routes
doing the same; it is how the spec stays honest rather than decorative.

---

## 7. Publishing, in detail

`POST /api/publish` → `session-bridge.ts` → shell `/publish/:workspaceId` →
`publisher/index.ts`.

The publisher opens the network's composer in a **hidden** window in that
workspace's partition and UA profile, types the approved body, submits, and
waits for the network's own confirmation. The attempt is bounded (shorter than
the API server's 20s timeout) so the shell, not a timeout, decides what an
unfinished attempt means.

**Adapter status — keep this table honest when it changes:**

| Networks | State |
| --- | --- |
| X | Bespoke adapter with its own selectors and submit flow; the reference implementation. |
| LinkedIn, Facebook, Threads, Bluesky, Mastodon, Tumblr | Driven through `compose-driver.ts`. **Selectors written from product knowledge, never run against a real signed-in account.** |
| Instagram, TikTok, YouTube, Pinterest | Refuse: a post needs image or video, a draft carries text. |
| Reddit | Refuses: needs a community and a title the draft model does not carry. |

A refusal names its own reason and points at the workspace tab. There is no
generic `501` any more, and adding a "temporary" one is a regression.

Selector drift shows up as a loud failure, never as a phantom post — but **no
adapter should be called working until someone has watched a real post land on
a real account**, X included. Nothing in this repo can prove that, because the
container it was written in has no display and no sessions. When you do verify
one, update this table, `README.md`, and `DEPLOY.md § 5` in the same commit.

---

## 8. Live sign-in (FaceMask)

`POST /api/session/signin` → bridge `POST /signin/:workspaceId` →
`publisher.beginSignIn`.

Both the sign-in and the status call take an optional `platform`, defaulting to
the workspace's own network: one identity can hold accounts on several networks,
and each is a separate session that must be read on its own.

- Opens the network's own login page **in that workspace's tab** via
  `ShellWindow.openOrFocusTab`. One tab per workspace: a workspace *is* an
  account, so a second tab is the same session shown twice.
- Returns as soon as the tab is up. A human sign-in takes minutes and often a
  second factor, so blocking on it would time out.
- `opened: true` says something about the *tab*, never about the account.
  Authentication is confirmed only by re-reading the session
  (`GET /api/session/status`). The UI polls it for up to three minutes after
  opening and flips its badge only on that evidence.
- The login view gets no preload, and nothing in this codebase touches the form.
- The Accounts page is the main entry: adding an account registers the row and
  opens that network's login page immediately, and an account's badge is written
  only from a session read — never from a tab having been opened.

`adapters.ts` carries a `signInUrl` per network; that is the only thing sign-in
needs from an adapter.

---

## 9. Scheduling

The API server owns the clock (`src/lib/scheduler.ts`), so a scheduled post goes
out whether or not the UI is open. Per tick it finds due, still-approved drafts
and pushes them through the same door the Post button uses.

- Intent is written to the dispatch log *before* the network call, so a crash
  mid-attempt cannot look like "never tried".
- A claim keeps one attempt per instruction; failure leaves the draft `failed`
  with the reason attached and waits for a person.
- The scheduler never writes the browser state document; the UI reconciles from
  `/schedule/dispatches`.

Two open project tasks live here (see §11).

---

## 10. Conventions

- **TypeScript everywhere**, strict. `pnpm run typecheck` must be clean.
- **Comments explain *why*, in prose.** Existing comments state the trap being
  avoided ("sanitising alone would collide two workspaces into one cookie jar").
  Match that register; do not add restating-the-code noise.
- **UI:** React + Tailwind + shadcn/ui in `components/ui` (leave those alone),
  app-specific pieces in `components/app` and `sections`. Interactive elements
  carry `data-testid` (`button-*`, `filter-*`, `draft-<id>`, `queue-<id>`,
  `calendar-post-<id>`).
- **Navigation** is section state in `App.tsx`, not a router.
  `onNavigate(section, { draftId })` focuses one post; the review queue widens
  its filter and scrolls to it. If a post can belong to another workspace,
  switch the active workspace *before* navigating, or the operator lands in a
  list that does not contain what they clicked.
- **Error surfaces** say what happened and what the operator can do. No toast
  that says "Something went wrong".
- **Tests** are `node --test` (no framework). Shell tests use scripted fakes and
  a fake clock rather than Electron.
- Commit messages are prose explaining the reasoning, not a bullet list of
  files.

---

## 11. Current state

**Working and verified here:** workspace isolation, UA/client-hint derivation,
the privileged origin gate, the approval gate (all refusal paths exercised
live), scheduled dispatch, the append-only ledger and its integrity check, the
idempotency ledger, the bridge contract, live sign-in end to end up to the point
where a real browser session is needed, and the calendar → review-queue flow.

**Not verified, and must not be described as working:** the six shared-composer
adapters against real accounts (§7). No display exists in the Replit container,
so nobody has watched them run.

**Dead until configured:** AI drafting needs `AIASSIST_API_KEY` (the legacy
`AIAssIST_API_KEY` spelling still works with a deprecation warning). Without it
`/api/ai/*` fails loudly.

**Open project tasks** (proposed, not started):

- Tell the operator when a scheduled post did not go out.
- Stop the app and server drifting apart on scheduling data.

**Not built:** signed installers per OS, per-tab UA switching (it is per
workspace), a sign-in indicator on the shell's own tab strip, any real
multi-tenant auth layer.

---

## 12. Traps that have already cost time

- **Native binaries.** The Replit workspace template excluded every
  non-linux-x64 optional binary (rollup, esbuild, lightningcss, Tailwind oxide)
  via `"-"` overrides in `pnpm-workspace.yaml`. That makes the repo unbuildable
  on macOS/Windows — where the shell is actually packaged — with
  `Cannot find module @rollup/rollup-darwin-x64`. They have been removed. If a
  template sync brings them back, remove them again.
- **`minimumReleaseAge: 1440`** in `pnpm-workspace.yaml` is a supply-chain
  guard. Leave it on; use the exclude list if something is genuinely urgent.
- **`nedb-engine` stays external** in the api-server esbuild bundle — bundling
  it breaks startup on a native binding.
- **`pnpm install` after pulling** if the lockfile moved, and delete
  `node_modules` if it was populated under the old lockfile.
- **`scripts/post-merge.sh`** runs `pnpm --filter db push`, inherited from the
  template. This project does not use that database; if a merge trips on it,
  that is why.
- **The Replit container is ephemeral.** Nothing counts until it is pushed to
  GitHub. The `origin` remote sometimes loses its credential in a fresh
  container; push with the stored PAT rather than rewriting the remote URL:
  ```bash
  git -c http.extraheader="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_PAT" | base64 -w0)" push origin main
  ```
  Never print or commit the token.
- **Agent memory** lives in `.agents/memory/` (index + topic files) and is
  committed with the code. Read it before starting; add a topic file when you
  learn something a future agent could not recover from the code. Keep secrets
  and changelogs out of it.

---

## 13. Working agreement with the owner

- Verify before claiming. "Typechecks" is not "works"; say which is which.
- Name the caveat rather than burying it — especially anything involving a post
  that may or may not have gone out.
- Do not spawn subagents in this project; the owner has asked for the work to be
  done directly in the main session.
- Push finished work to `main` with the reasoning in the commit message.
