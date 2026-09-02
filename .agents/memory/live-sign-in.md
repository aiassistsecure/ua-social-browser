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
