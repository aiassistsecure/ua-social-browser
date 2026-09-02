---
name: Publishing boundary
description: The non-negotiable rule about how posts reach a social network in this project, and what the web surface may do.
---

A post reaches a network only through the human's own signed-in browser session
inside the native shell, carrying an explicit human approval. There is no
server-held platform token and no server-side posting path.

**Why:** the product's whole claim is that a model drafts and a person signs. A
server-side fallback would turn it into an autonomous poster, which is the thing
it is explicitly not. Equally, a "marked as published" UI state that never hit
the network is a lie about whether something reached an audience.

**How to apply:**
- When the session bridge is absent, publishing returns 503 with a plain reason
  and the draft becomes `failed` with that reason attached. Never a silent
  success, never a queued-for-later pretence.
- Editing an approved draft clears its approval. Approval is on the exact text.
- The idempotency key derives from draft id + approval timestamp, so a retry
  cannot double-post. Scheduled sends go through the same door as the Post
  button — see [Scheduled dispatch](scheduled-dispatch.md).

**Known gap, deliberately open:** approval is asserted by the browser document,
and the API is unauthenticated with open CORS. Anyone who can reach the server
can write a due, "approved" draft and the scheduler will send it. That was
survivable when a person had to press Post; automatic dispatch makes the
server-side approval boundary load-bearing. Closing it means server-authorized
approval transitions plus authenticated state/publish endpoints — treat any
work near this as security-critical rather than as plumbing.
- Live network views render only in the shell. Social networks block framing, so
  the web surface shows an explicit "runs in the desktop shell" state instead of
  a mocked feed.
