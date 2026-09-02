---
name: Scheduled dispatch
description: The invariants that let the server send a post on its own without racing the browser or posting twice.
---

Automatic sending sits between two actors that do not coordinate: the server's
scheduler, and the person editing drafts in the browser. Four rules keep that
honest. Break any one and the failure is unrecoverable, because a post cannot be
recalled.

**The browser's state document has exactly one writer — the browser.** The
server reports what it did through a separate log the browser reads back.
**Why:** the app saves that document whole, last-write-wins. A server writing
into it is silent data loss, not a conflict anyone would notice.

**Approval is re-read from storage and the draft locked in one synchronous step
immediately before the send.** No await between checking and locking. While the
lock is held, a state write touching that draft is refused for it and the
browser is told. **Why:** a tick sends one draft at a time, so a slow send makes
the next draft's snapshot seconds stale — long enough to use an approval that
was already taken back. Once the send has started the only honest answers are
"skipped" or "it already went out"; there is no third one.

**The attempt for a send time belongs to the instruction, not to whoever made
it.** A person pressing Post on a post that is also due consumes that
instruction's one attempt. **Why:** the two actors take the same lock, so they
cannot coalesce — the loser simply steps aside. If the bound is per-actor, the
scheduler comes back after the person's attempt fails and sends it anyway.

**The intent is written down before the network call, never after.** On startup,
anything still mid-send is resolved to uncertain and handed to a person.
**Why:** the fatal state is having sent a post with nothing on disk saying so —
the process dies and the next pass sends it again. Nothing can distinguish that
from "never sent" until the bridge can be asked, so guessing means duplicating
something unrecallable.

**Two keys, two jobs.** Never-post-twice keys on draft + approval. Bounding
automatic retries keys on that plus the send time. **Why:** collapse them and
you get one of two bugs — retrying a failure forever, or a rescheduled failure
that silently never fires.

**Nothing in that log is ever pruned.** **Why:** a scheduled draft stays
scheduled in the browser's document until that browser reconciles it, possibly
weeks later, and the record saying "already sent" is the only thing preventing a
second send. Trimming the oldest entries posts the oldest unreconciled drafts
twice. For the same reason reconciliation is a lookup by name, not a recent
feed: an outcome must not be able to scroll off a page while nobody was looking.
