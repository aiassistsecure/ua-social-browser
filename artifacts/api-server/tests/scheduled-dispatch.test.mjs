import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  approvedAt,
  draft,
  future,
  past,
  startStack,
  unapproved,
} from "./helpers/stack.mjs";

/**
 * What a scheduled post is allowed to do.
 *
 * These tests exist because the failure they guard against is not recoverable:
 * a post that goes out without a current human approval, or goes out twice,
 * cannot be taken back once an audience has seen it.
 */

describe("a scheduled post that comes due", () => {
  let stack;

  before(async () => {
    stack = await startStack();
    await stack.putState([
      draft("due"),
      unapproved("edited-since-approval"),
      draft("later", { scheduledFor: future() }),
      draft("not-scheduled", { status: "approved", scheduledFor: null }),
    ]);
    await stack.settle();
  });

  after(() => stack.stop());

  it("goes out on its own, through the session, without anyone pressing Post", async () => {
    assert.deepEqual(
      stack.shell.received.map((request) => request.draftId),
      ["due"],
    );
  });

  it("is recorded as sent by the scheduler", async () => {
    const record = (await stack.dispatches()).find((r) => r.draftId === "due");
    assert.equal(record?.status, "published");
    assert.equal(record?.source, "scheduler");
  });

  it("is skipped, not sent, when the draft has lost its approval", async () => {
    const log = await stack.dispatches();
    assert.ok(!log.some((r) => r.draftId === "edited-since-approval"));
  });

  it("is left alone when its time has not arrived", async () => {
    const log = await stack.dispatches();
    assert.ok(!log.some((r) => r.draftId === "later"));
  });

  it("is not sent again by a later pass", async () => {
    await stack.settle();
    assert.equal(stack.shell.received.length, 1);
  });

  it("cannot be double-posted by someone pressing Post at the same moment", async () => {
    const { status, body } = await stack.publish({
      workspaceId: "ws-1",
      draftId: "due",
      platform: "x",
      body: "body of due",
      approval: { approvedBy: "Ada", approvedAt },
      idempotencyKey: `due:${approvedAt}`,
    });

    assert.equal(status, 200);
    assert.equal(body.status, "published");
    assert.equal(stack.shell.received.length, 1);
  });
});

describe("a scheduled post that fails", () => {
  let stack;

  before(async () => {
    stack = await startStack();
    stack.shell.reject();
    await stack.putState([draft("rejected")]);
    await stack.settle();
  });

  after(() => stack.stop());

  it("is recorded as failed, with the reason the platform gave", async () => {
    const record = (await stack.dispatches()).find(
      (r) => r.draftId === "rejected",
    );
    assert.equal(record?.status, "failed");
    assert.match(record?.message, /platform said no/i);
  });

  it("is not retried in a loop", async () => {
    const attempts = stack.shell.received.length;
    await stack.settle();
    assert.equal(stack.shell.received.length, attempts);
  });

  it("can still be sent by a person choosing to retry", async () => {
    stack.shell.accept();
    const { status, body } = await stack.publish({
      workspaceId: "ws-1",
      draftId: "rejected",
      platform: "x",
      body: "body of rejected",
      approval: { approvedBy: "Ada", approvedAt },
    });

    assert.equal(status, 200);
    assert.equal(body.status, "published");
  });
});

describe("a failed post moved to a new time", () => {
  let stack;
  const firstTime = past(240_000);
  const secondTime = past(120_000);

  before(async () => {
    stack = await startStack();
    stack.shell.reject();
    await stack.putState([draft("moved", { scheduledFor: firstTime })]);
    await stack.settle();
  });

  after(() => stack.stop());

  it("gets one more attempt, because a new time is a new instruction", async () => {
    assert.equal(stack.shell.received.length, 1);

    stack.shell.accept();
    await stack.putState([draft("moved", { scheduledFor: secondTime })]);
    await stack.settle();

    assert.equal(stack.shell.received.length, 2);
  });

  it("still cannot be posted twice once it has gone out", async () => {
    // The browser has not reconciled yet, so its document still says scheduled.
    await stack.putState([draft("moved", { scheduledFor: secondTime })]);
    await stack.settle();
    await stack.putState([draft("moved", { scheduledFor: past(60_000) })]);
    await stack.settle();

    assert.equal(stack.shell.received.length, 2);
  });

  it("keeps each attempt tied to the time it was made for", async () => {
    const log = await stack.dispatches();
    assert.ok(
      log.some((r) => r.status === "failed" && r.scheduledFor === firstTime),
    );
    assert.ok(
      log.some((r) => r.status === "published" && r.scheduledFor === secondTime),
    );
  });
});

describe("an approval taken back while a send is already running", () => {
  let stack;
  const HOLD_MS = 2000;

  before(async () => {
    stack = await startStack();
    stack.shell.hold(HOLD_MS);
  });

  after(() => stack.stop());

  it("wins, even though the scheduler had already judged the post eligible", async () => {
    // Two due posts. The first occupies the session for seconds, which is what
    // makes the scheduler's view of the second one stale.
    const first = draft("first");
    await stack.putState([first, draft("second")]);
    assert.ok(await stack.waitForShell(1));
    assert.equal(stack.shell.received[0].draftId, "first");

    const write = await stack.putState([first, unapproved("second")]);
    assert.deepEqual(write.heldDrafts, []);

    await stack.settle(HOLD_MS + 2500);

    assert.deepEqual(
      stack.shell.received.map((request) => request.draftId),
      ["first"],
    );
    const log = await stack.dispatches();
    assert.ok(!log.some((r) => r.draftId === "second"));
  });

  it("is refused, not silently swallowed, once the post is on its way out", async () => {
    await stack.putState([draft("third")]);
    assert.ok(await stack.waitForShell(2));

    const late = await stack.putState([unapproved("third")]);
    assert.deepEqual(late.heldDrafts, ["third"]);

    const held = late.state.drafts.find((d) => d.id === "third");
    assert.equal(held.status, "scheduled");
    assert.equal(held.approvedBy, "Ada");
    assert.equal(held.body, "body of third");
  });

  it("still reports the truth about what happened", async () => {
    await stack.settle(HOLD_MS + 2500);

    const record = (await stack.dispatches()).find((r) => r.draftId === "third");
    assert.equal(record?.status, "published");
    assert.equal(stack.shell.received.length, 2);
  });
});

describe("the identity of a post", () => {
  let stack;

  before(async () => {
    stack = await startStack();
    await stack.putState([draft("identified", { scheduledFor: future() })]);
  });

  after(() => stack.stop());

  const post = (extra) =>
    stack.publish({
      workspaceId: "ws-1",
      draftId: "identified",
      platform: "x",
      body: "body of identified",
      approval: { approvedBy: "Ada", approvedAt },
      ...extra,
    });

  it("cannot be renamed by the caller to slip a second copy through", async () => {
    const first = await post();
    assert.equal(first.status, 200);
    assert.equal(stack.shell.received.length, 1);

    const invented = await post({ idempotencyKey: "some-other-key" });
    assert.equal(invented.status, 400);
    assert.equal(stack.shell.received.length, 1);
  });

  it("is the same post on a second press, so it is not sent again", async () => {
    const again = await post();
    assert.equal(again.status, 200);
    assert.equal(again.body.status, "published");
    assert.equal(stack.shell.received.length, 1);
  });
});

describe("a scheduled post that comes due mid-press", () => {
  let stack;
  const HOLD_MS = 2500;

  before(async () => {
    stack = await startStack({ intervalMs: 400 });
    stack.shell.hold(HOLD_MS);
    stack.shell.reject();

    // The operator presses Post on a draft that is also due. The scheduler's
    // next pass joins that same attempt rather than making a second one.
    await stack.putState([draft("contested")]);
    const pressed = stack.publish({
      workspaceId: "ws-1",
      draftId: "contested",
      platform: "x",
      body: "body of contested",
      approval: { approvedBy: "Ada", approvedAt },
    });
    assert.ok(await stack.waitForShell(1));
    await pressed;
    await stack.settle(HOLD_MS + 1500);
  });

  after(() => stack.stop());

  it("is only sent once, by whichever of the two got there first", async () => {
    assert.equal(stack.shell.received.length, 1);
  });

  it("counts as the one attempt for that send time, whoever made it", async () => {
    const log = await stack.dispatches();
    const attempts = log.filter((record) => record.draftId === "contested");

    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, "failed");
  });

  it("so a later pass does not quietly send it after all", async () => {
    stack.shell.accept();
    await stack.settle(2000);
    assert.equal(stack.shell.received.length, 1);
  });
});

describe("a workspace that has been closed for a long time", () => {
  let stack;
  // Past any tidy-up threshold: nothing that prevents a resend may be dropped,
  // and nothing may fall off the end of a page while nobody was looking.
  const VOLUME = 210;
  const drafts = Array.from({ length: VOLUME }, (_, index) =>
    draft(`bulk-${index}`),
  );

  before(async () => {
    stack = await startStack();
    await stack.putState(drafts);
    assert.ok(await stack.waitForShell(VOLUME, 60_000));
    await stack.settle();
  });

  after(() => stack.stop());

  it("learns the outcome of every post, not just the recent ones", async () => {
    const response = await fetch(`${stack.base}/schedule/outcomes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        keys: drafts.map((item) => `${item.id}:${approvedAt}`),
      }),
    });
    const { outcomes } = await response.json();

    assert.equal(outcomes.length, VOLUME);
    assert.ok(outcomes.every((record) => record.status === "published"));
  });

  it("does not have its oldest posts sent a second time", async () => {
    // The document still says every one of them is scheduled, because a closed
    // browser never reconciled them. Only the log stands in the way.
    await stack.putState(drafts);
    await stack.settle();

    assert.equal(stack.shell.received.length, VOLUME);
  });
});

describe("with no desktop shell attached", () => {
  let stack;

  before(async () => {
    stack = await startStack({ bridge: false });
    await stack.putState([draft("orphan")]);
    await stack.settle();
  });

  after(() => stack.stop());

  it("says so plainly rather than implying posts are being held", async () => {
    const status = await stack.schedulerStatus();
    assert.equal(status.bridgeConfigured, false);
    assert.match(status.detail, /marked failed/i);
  });

  it("marks a due post failed instead of pretending it is still queued", async () => {
    const record = (await stack.dispatches()).find(
      (r) => r.draftId === "orphan",
    );
    assert.equal(record?.status, "failed");
    assert.match(record?.message, /desktop shell/i);
  });
});
