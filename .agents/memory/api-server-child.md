---
name: The API server child process
description: Why an orphaned API server breaks the next launch, and the rules for reclaiming it safely.
---

The shell runs the workspace API server as a child process, and that child holds
an **exclusive lock on the data directory** — the store refuses a second opener
on purpose, because two engines on one set of files cannot see each other's
writes.

## A quit that does not wait is a broken next launch

Nothing in the OS ends the child when the parent goes. If the shell exits while
it is still alive, the next start fails with a lock error naming a pid, which
tells the operator nothing they can act on.

**Why:** the symptom appears one launch later than the cause, so it reads as
"the app is broken" rather than "the last quit left something running".

**How to apply:** the quit path holds the exit until the child is gone, and a
last-resort exit hook signals it. Anything that adds a new exit path has to keep
that property.

## Killing a recorded pid is only safe with a second check

Reclaiming an orphan means signalling a pid read off disk, and pids are reused.

**Why:** the difference between cleaning up our own leftovers and ending a
stranger's process is one round of pid reuse.

**How to apply:** record the pid *and* what was started, and only signal when
the live process's command line still matches. A pid that no longer matches is
left alone and the note is discarded.

## Tests that guess a port fail as something else

A test that picks a random port in a fixed range collides with whatever else
the machine runs, and the failure looks like a broken server rather than an
occupied port. Ask the OS for a free port instead.
