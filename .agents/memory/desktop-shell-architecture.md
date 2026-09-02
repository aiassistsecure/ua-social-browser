---
name: Desktop shell architecture
description: Why the native shell is Electron rather than a patched Chromium fork, and the invariants that keep the publishing path honest.
---

# The shell is Electron, not a Chromium fork

Planning docs called for a source-patched Chromium fork. The shell is built on
Electron instead.

**Why:** every capability the fork was wanted for is already exposed by
Electron, which *is* Chromium — a persisted session partition is a real
BrowserContext with its own on-disk profile and cookie jar, and CDP's user-agent
and timezone overrides are the same mechanism a patch would drive. A fork adds a
~100 GB checkout, a multi-hour build, and a permanent rebase burden for nothing
extra, and cannot be built or verified in this container at all.

**How to apply:** treat "patch Chromium" in older plans as satisfied. Only
revisit for something needing C++-level change, e.g. Chromium's own TLS/JA3
fingerprint, which no JS-level override can reach.

# Invariants that must survive any change to the shell

- **Loopback is not an authorization boundary.** The bridge that publishes
  through the operator's live sessions bypasses the API server's human-approval
  check by construction, so it must require a capability the shell mints at
  runtime and gives only to the API server it starts. Any local process, and any
  page the operator visits, can otherwise reach 127.0.0.1. There must be no
  default on-disk location for that capability. The same applies one layer up:
  whatever holds that capability must itself bind loopback and be gated, or it
  becomes an open proxy to the publisher.
- **Approval is state, not an assertion.** A publish request carrying its own
  "approved by / approved at" fields proves nothing — the sender writes them.
  The sign-off must be read from stored state, and the submitted text compared
  against the approved text, or an approved draft id becomes a licence to post
  anything.
- **Sanitising an identifier is not the same as keying by it.** Folding unsafe
  characters to `-` makes distinct workspace ids collide, and two colliding ids
  share one cookie jar — the exact cross-account leak the product exists to
  prevent. Any id used as a storage key needs a digest of the raw value.
- **Gating a component means re-checking everything inside it.** When the shell
  started requiring a token on its own API, the unit suites stayed green while
  the product was dead: an internal reader without the token silently saw an
  empty world, so no workspace resolved and nothing could publish. Any new
  authorization boundary needs one test that runs the real chain end to end.
- **UA fidelity is all-or-nothing.** Client hints are derived from the UA string
  itself, and a non-Chromium UA emits none. A Chrome UA paired with mismatched
  hints is *more* identifying than no override.
- **Exactly one page is privileged.** Only the workspace sidebar gets a preload
  and the shell bridge; network surfaces, tabs, and the hidden publish window
  get none, and the main process checks the IPC sender. Giving a network page a
  preload breaks the entire security story.
- **An unconfirmed publish is terminal.** Submitted-but-unconfirmed is recorded
  as spent and answered the same way forever; retrying risks a duplicate post,
  which is worse than an error. "Not signed in" is *not* terminal.
- **Automation coverage stays honest.** A network without a real composer
  adapter refuses and says so. Never substitute a fabricated success.

**Why:** the product's one promise is that a post either went out through the
operator's own session or is reported as not sent. Every shortcut above trades
that promise for convenience.
