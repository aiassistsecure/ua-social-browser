---
name: Blank tabs in the desktop shell
description: Why a workspace tab can open black with no error, and the two rules that prevent it.
---

The shell opens network pages in `WebContentsView`s inside a `BaseWindow`. Two
independent mistakes produce the same symptom — a black rectangle where the
page should be, with nothing in any log — and it reads to the operator as "the
app is broken" rather than "nothing loaded".

## A fresh view has no renderer, so renderer-answered work must not gate the load

CDP `Emulation.*` commands are answered by the renderer, and a view that has
never loaded anything does not have one. Awaiting them before `loadURL` can
hang until something loads, which never happens.

**Why:** this deadlocked the tab-open path once; the call that opened the tab
timed out upstream, and the view sat black for the rest of the session.

**How to apply:** identity setup runs with a deadline and the navigation starts
regardless. Request headers come from the session anyway; the renderer-side
half (`navigator.userAgentData`, timezone) is re-applied on `dom-ready`.

## "Which URL was this tab created with" is not "what is this tab showing"

Reuse logic that compares a requested URL recorded at creation will skip the
load for a tab that never navigated — so the second attempt focuses the same
blank view and the tab can never recover.

**Why:** the black tab survived every retry because each retry believed the
page was already up.

**How to apply:** decide from `webContents.getURL()`. Empty means nothing ever
loaded. Compare origins, not exact URLs, so pressing sign-in again does not
reload a login form the operator is halfway through.

## A page that fails must say so on screen

Main-frame `did-fail-load` (excluding ERR_ABORTED) is logged and replaced with a
plain no-script failure page naming the URL and the error. A dark-themed
network page and a page that never arrived look identical otherwise.
