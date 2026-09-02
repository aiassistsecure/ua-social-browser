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
