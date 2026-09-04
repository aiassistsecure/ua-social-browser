---
name: Live in-shell sign-in (FaceMask)
description: How accounts get authenticated in the desktop shell, and the two invariants that keep the claim honest.
---

Accounts are authenticated by the operator, inside the shell, on the network's
own login page, under the workspace's isolated session and UA profile. The app
never reads, fills, or stores credentials, and mints no token of its own.

## One tab per workspace

A workspace *is* an account, so a second tab for the same workspace is not a
second account — it is one session shown twice.

**Why:** two views of one session is how an operator posts from a stale view, or
signs in on a tab they are not watching.

**How to apply:** anything that opens a network page for a workspace should
create-or-focus that workspace's tab, never stack a new one.

## Opening a tab proves nothing about an account

A sign-in call returns as soon as the login page is up, and reports only what
happened to the tab (`opened`, `alreadySignedIn`).

**Why:** a human sign-in takes minutes and often a second factor; blocking on it
would time out, and treating "tab opened" as "signed in" would let the UI claim
an account that does not exist yet.

**How to apply:** the signed-in claim comes from re-reading the session (cookie
jar) afterwards. Poll status with a bounded window; never infer authentication
from the act of opening, and never from a UI timer expiring.

## A workspace is one identity, but it can hold several networks

Sign-in and session-status both take an optional network, defaulting to the
workspace's own. The login page still opens in that workspace's tab, so the
isolation story is unchanged.

**Why:** an operator registers accounts on more than one network under a single
identity, and a session on one is no evidence at all about another.

**How to apply:** read each account's session for its own network, and never
draw one account's badge from a sibling's session. A registry row that the
operator can toggle "linked" by hand is the same lie in slower motion — any
control that sets that flag without a session read has to go.

## Which account, not just whether

An opened tab is not evidence of an account, and neither is a stored label.

`sessionStatus` reports `accountId` from the partition's cookies (X `twid`,
Instagram/Threads `ds_user_id`, Facebook `c_user`) and `accountHandle` read
from a live signed-in page for that workspace — `ShellWindow.liveContentsFor`
returns the embedded network view if it is loaded, otherwise a tab. The handle
carries `handleSource: "session"`, and the UI names an account only when that
field is set. Everything else is `handleUnknown`, shown verbatim.

**The handle read is bounded and briefly cached.** Reading it means asking a
live page a question, and a busy single-page app can take its time: this cost
**6080 ms** in the field, on an endpoint the UI polls. So the read gets
`IDENTITY_READ_BUDGET_MS` (1.2s) and then reports "the page was too busy to say
which account is signed in" — a distinct message, because a slow page is not a
network that moved its markup, and saying the wrong one sends the next person
hunting a selector that is fine.

Only the *handle* is cached (`publisher/identity-cache.ts`), for 30s, and
4s when the read failed — a miss usually means the page had not finished
arriving, and holding that answer would turn a passing miss into a lasting
"unknown". **`authenticated` and `accountId` are never cached**: they come from
the cookie jar, cost nothing, and a stale "signed in" is precisely the lie this
shell exists to avoid.

The safety rule is the binding, not the clock. Every entry is bound to the
account id the cookies reported when it was stored, and a mismatch drops it
before its age is even considered — so a cached handle cannot outlive the
account it names. Networks with no id cookie (Bluesky, Mastodon) have nothing
to bind to, which is why the TTL is seconds. Opening a sign-in tab invalidates
the entry, since whoever is signed in may not be in a moment.

**Never read `workspace.accountHandle` for this.** That field is a label the
operator typed once. It was previously returned by `sessionStatus` and printed
as "Signed in as @…", which meant a workspace carrying a handle from an old
seed told the owner he was posting from `@northstarhq` — an account that never
existed — while a real, different account was signed in. The pure logic in
`publisher/identity.ts` is covered by tests including one asserting that no
input path can produce a handle from anything but a page read.

The handle selectors are product knowledge and unverified. A miss must be
"unknown", never a wrong name — that is the whole point.

## Signing out, and why the Accounts page was dangerous without it

The trash icon on the Accounts page (`aria-label` was "Remove account") used
to run exactly this:

    accounts: current.accounts.filter((item) => item.id !== accountId)

Nothing in the codebase could remove a cookie at all — no `clearStorageData`,
no `cookies.remove`. So the row went and the session stayed.

The full mechanism the owner hit, 2026-09-04:

1. Trash the account. The label goes; the jar is untouched.
2. Add an account with a different handle. `addAccount` writes the row with
   `connected: false` and **immediately calls `startSignIn`**.
3. The login page opens in a workspace whose jar still holds the previous
   account's cookies — so the network redirects straight to the feed, already
   signed in.
4. The session check answers `authenticated` (true of the jar), and the *new*
   label lights up "Signed in".

The new name inherits the old account's session end to end. And because a
draft carries a workspace and a platform but **no account**, publishing goes
through that jar: an approved post would have gone out from whoever was
actually in it.

`publisher/sign-out.ts` + `POST /api/session/signout` fix the capability; the
trash icon now signs out first and removes the label **only if the sign-out
verified**. A failed sign-out that still forgot the label would leave no row
and a live session, which is worse than either problem alone. Because it is
destructive — a real re-login, possibly with a second factor — it confirms
first, and the dialog says which network and which workspace.

**Still true and still worth fixing:** `account.connected` is a stored boolean
written at some past check, not the live session, and adding an account into a
workspace that already holds a session for that network silently inherits it
rather than warning. The structural answer is to give drafts an account and
refuse to publish when the signed-in handle does not match the approved one —
that is the only version where wrong-account publishing is impossible rather
than merely less likely.
