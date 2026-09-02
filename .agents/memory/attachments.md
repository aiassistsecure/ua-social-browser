---
name: Attachments
description: Where uploaded files live, why they are not in the state document, and the two checks that keep a post's pictures honest.
---

Drafts carry images and video. The bytes do not travel with them.

**Where the bytes live.** `artifacts/api-server/src/lib/media-store.ts` writes
uploads to `<NEDB_DATA_DIR>/media/<tenant>/<sha256>/<filename>`. The directory
is the hash of the contents; the file keeps a sanitised version of its original
name, because that name is what the network shows on the post. A draft, and
later a publish request, carry only a reference.

**Why not in the state document.** The browser state is PUT whole on a debounce
behind a textarea. An image inside it would be rewritten on every keystroke,
and the append-only ledger would keep every copy for good.

**How a file reaches a network.** The API server resolves each reference to an
absolute path and sends that over the bridge. Both processes see one
filesystem: the shell chose `NEDB_DATA_DIR` and spawned the server with it. The
shell then does two things before anything is uploaded
(`desktop/ua-shell/src/publisher/approved-media.ts`):

1. Refuses any path outside its own data directory. The bridge is loopback and
   token-gated, but the component that turns a path into "upload this file"
   should not be the component that trusts its input.
2. Re-hashes the file. An approval is for exact content, and content includes
   the picture — a file that no longer matches the recorded hash is not the one
   that was approved, so the post does not go out.

The upload itself is CDP `DOM.setFileInputFiles`
(`desktop/ua-shell/src/publisher/upload.ts`). Page JavaScript cannot set
`input.files`, and clicking the input opens a native dialog nothing here can
drive. The debugger is already attached for UA emulation, so this reuses that
session — attaching twice throws.

**The rules that matter, all covered by tests:**

- The publish path compares submitted attachments against the stored draft and
  refuses a mismatch. Without that, an approved draft id is a licence to post
  any image. A dropped attachment and an edited alt text are both mismatches:
  alt text is published content.
- Attachments are a dispatch field in `routes/browser.ts`, so they cannot be
  swapped under a send in flight. They could not join `DISPATCH_FIELDS`
  directly — that list compares with `!==`, and two arrays are never `===`, so
  every save would have reported a change. They are compared by fingerprint
  instead.
- The composer flow attaches *before* it submits and waits for the network to
  acknowledge the upload. Submitting early posts the words without the picture,
  which is a different post from the approved one.
- A file that cannot be attached fails the post. It never degrades to
  text-only.
- A missing file fails the whole dispatch rather than posting the attachments
  that did resolve.

**Not verified:** every `fileInput` selector in `adapters.ts` is written from
product knowledge and has never run against a real signed-in account. A drifted
selector surfaces as a loud refusal, not a phantom post — but treat the
selectors as unproven until someone watches a picture land.

**Still refusing:** Instagram, TikTok, YouTube, Pinterest. Not because a draft
cannot carry media any more — it can — but because each posts through a
multi-step flow (choose, crop, filter, describe, share) that the four-phase
composer driver cannot express. Pinterest is the cheapest to unlock first: one
step, image plus caption.
