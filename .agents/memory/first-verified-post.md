---
name: First verified post
description: What has actually been watched landing on a real account, and what that does and does not prove.
---

On 2026-09-02 the owner published a real post on X from the macOS shell:
account `@interchained`, workspace "Product Updates" (Chrome · Windows UA
profile), body "Shipping the smallest useful version is a strategy, not a
compromise." The review-queue card flipped to *posted* and its "View it on X"
link resolved to the live status. That is the first time any adapter in this
repo was observed doing the thing it claims to do.

**Why this matters:** every earlier note said "no adapter has been watched
working, X included" because the Replit container has no display and no
sessions. That sentence is now false for X and still true for the other six
driven networks. The docs (`AGENTS.md § 7/§ 11`, `README.md`, `DEPLOY.md § 5/§ 10`)
were updated in the same commit as this file.

**How to apply:**
- Describe X's approve → publish → confirm path as verified. Do not describe it
  as covered: one post, one account, one OS. X UI states that were not
  exercised (media prompts, rate-limit interstitials, a changed composer) can
  still fail — loudly, as designed.
- Keep LinkedIn, Facebook, Threads, Bluesky, Mastodon and Tumblr marked as
  written-from-product-knowledge until someone watches each land a real post.
- When another adapter is verified, record the same four facts here: date, OS
  the shell ran on, account, and what the UI showed — then update the same
  three docs in one commit.

## The second verified network: Instagram, 2026-09-03

One real post on a real account (`paper_bagboys`), image and caption both
present in the feed, from the macOS shell. Same standard of evidence as X: the
owner watched it land.

Getting there took four separate bugs, and **not one of them was findable by
reading the code**:

1. `opener` matched `svg[aria-label="New post"]`, and `SVGElement` has no
   `.click()` — so opening the composer threw a `TypeError` every time.
   Instagram publishing had never worked and could not have.
2. The crop and filter steps clicked "the first enabled `div[role="button"]`",
   which on both screens is **Back**, while waiting for a dialog that was
   already open — so walking backwards reported success.
3. The workspace ran the **iPhone** UA profile, so Instagram served the mobile
   layout with no sidebar at all. Fixed by driving `/create/select/` directly
   and by letting the UA profile select the graph.
4. `editorKind` was a single declared value while the selector matched either a
   `textarea` or a contenteditable `div`; the mismatch called a value setter on
   a `div`, and `(undefined ?? "").trim().length` was the "0 characters"
   reported.

The lesson is the one from X, sharper: an adapter that reads correctly is worth
approximately nothing. **The verified post is the only evidence.** Each of these
was found by driving a real signed-in account, and each refusal message had to
be made specific before the next one could be found — the generic ones actively
pointed at the wrong suspect.

**Verified under Chrome · macOS.** The mobile graph is written and shipped but
has never been watched working; a failure now names the UA profile first.
