import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  runComposeFlow,
  type ComposerPage,
  type ConfirmState,
  type ProbeState,
} from "../src/publisher/compose-driver";
import { unconfirmedOutcome } from "../src/idempotency";
import type { PublishOutcome } from "../src/session-bridge-server";

/**
 * "Submitted, outcome unknown" is a refusal carrying a specific status, not a
 * kind of its own — so asserting the kind alone would not tell it apart from an
 * ordinary rejection. Both halves are checked against the ledger's own shape.
 */
const UNCONFIRMED = unconfirmedOutcome("probe");
const statusOf = (outcome: PublishOutcome) =>
  "status" in outcome ? outcome.status : undefined;

function assertUnconfirmed(outcome: PublishOutcome) {
  assert.notEqual(outcome.kind, "published", "an unknown outcome is never a success");
  assert.equal(outcome.kind, UNCONFIRMED.kind);
  assert.equal(
    statusOf(outcome),
    statusOf(UNCONFIRMED),
    "an unconfirmed attempt must carry the status that keeps it out of automatic retries",
  );
}

type Script = {
  probe?: ProbeState[];
  probeUpload?: ProbeState[];
  advance?: boolean[];
  present?: boolean[];
  enterText?: { ok: boolean; detail?: string };
  attachMedia?: { ok: boolean; detail?: string };
  mediaReady?: boolean[];
  clickSubmit?: boolean[];
  confirm?: ConfirmState[];
};

/**
 * A page that answers from a script.
 *
 * The last entry of each queue repeats, so "always waiting" is one value and
 * the deadline decides when the flow gives up.
 */
function fakePage(script: Script) {
  const calls: string[] = [];
  const next = <T>(queue: T[] | undefined, fallback: T): T => {
    if (!queue || queue.length === 0) return fallback;
    return queue.length === 1 ? queue[0]! : queue.shift()!;
  };

  const page: ComposerPage = {
    async probe() {
      calls.push("probe");
      return next(script.probe, "waiting");
    },
    async probeUpload() {
      calls.push("probeUpload");
      return next(script.probeUpload, "composer");
    },
    async advance(selector: string) {
      calls.push(`advance:${selector}`);
      return next(script.advance, true);
    },
    async present(selector: string) {
      calls.push(`present:${selector}`);
      return next(script.present, true);
    },
    async openComposer() {
      calls.push("openComposer");
      return true;
    },
    async enterText(text: string) {
      calls.push(`enterText:${text}`);
      return script.enterText ?? { ok: true };
    },
    async attachMedia(paths: string[]) {
      calls.push(`attachMedia:${paths.join(",")}`);
      return script.attachMedia ?? { ok: true };
    },
    async mediaReady() {
      calls.push("mediaReady");
      return next(script.mediaReady, true);
    },
    async clickSubmit() {
      calls.push("clickSubmit");
      return next(script.clickSubmit, false);
    },
    async pressSubmitHotkey() {
      calls.push("pressSubmitHotkey");
    },
    async confirm() {
      calls.push("confirm");
      return next(script.confirm, { state: "waiting" });
    },
  };

  return { page, calls };
}

/** A clock that only moves when the flow sleeps, so tests are instant. */
function clock(budgetMs: number) {
  let current = 0;
  return {
    deadline: budgetMs,
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
  };
}

function run(
  script: Script,
  over: Partial<{
    allowHotkey: boolean;
    hasOpener: boolean;
    media: string[];
    canAttach: boolean;
    reportsMediaReady: boolean;
    mediaRequired: boolean;
    mediaFirst: boolean;
    afterAttach: Array<{ click: string; waitFor: string; label: string }>;
  }> = {},
) {
  const { page, calls } = fakePage(script);
  const time = clock(5_000);
  return runComposeFlow(page, {
    label: "TestNet",
    body: "the approved words",
    media: over.media ?? [],
    canAttach: over.canAttach ?? true,
    reportsMediaReady: over.reportsMediaReady ?? true,
    mediaRequired: over.mediaRequired ?? false,
    mediaFirst: over.mediaFirst ?? false,
    ...(over.afterAttach ? { afterAttach: over.afterAttach } : {}),
    deadline: time.deadline,
    allowHotkey: over.allowHotkey ?? false,
    hasOpener: over.hasOpener ?? false,
    sleep: time.sleep,
    now: time.now,
  }).then((outcome) => ({ outcome, calls }));
}

describe("the shared composer flow", () => {
  test("a login screen is reported as a signed-out session, not a failure", async () => {
    const { outcome, calls } = await run({ probe: ["login"] });

    assert.equal(outcome.kind, "unauthenticated");
    assert.ok(
      !calls.some((call) => call.startsWith("enterText")),
      "nothing may be typed into a login page",
    );
  });

  test("a composer that never appears submits nothing", async () => {
    const { outcome, calls } = await run({ probe: ["waiting"] });

    assert.equal(outcome.kind, "rejected");
    assert.match(String(outcome.detail), /did not load/);
    assert.ok(!calls.includes("clickSubmit"), "nothing may be submitted without a composer");
  });

  test("a hidden composer is opened once before giving up on it", async () => {
    const { calls } = await run({ probe: ["waiting", "waiting", "composer"] }, { hasOpener: true });

    assert.equal(
      calls.filter((call) => call === "openComposer").length,
      1,
      "the opener is clicked once, not on every poll",
    );
  });

  test("text that does not land in the composer is never submitted", async () => {
    const { outcome, calls } = await run({
      probe: ["composer"],
      enterText: { ok: false, detail: "The composer holds 4 characters but the post is 18." },
    });

    assert.equal(outcome.kind, "rejected");
    assert.match(String(outcome.detail), /Could not enter the post text/);
    assert.ok(!calls.includes("clickSubmit"), "a half-typed post must not be sent");
  });

  test("a submit button that never enables is a refusal, not a silent skip", async () => {
    const { outcome, calls } = await run({ probe: ["composer"], clickSubmit: [false] });

    assert.equal(outcome.kind, "rejected");
    assert.match(String(outcome.detail), /never enabled its post button/);
    assert.ok(!calls.includes("confirm"), "there is nothing to confirm");
  });

  test("the keyboard shortcut is the fallback where a network has one", async () => {
    const { outcome, calls } = await run(
      { probe: ["composer"], clickSubmit: [false], confirm: [{ state: "sent" }] },
      { allowHotkey: true },
    );

    assert.ok(calls.includes("pressSubmitHotkey"));
    assert.equal(outcome.kind, "published");
  });

  test("a post is published only on the network's own confirmation", async () => {
    const { outcome } = await run({
      probe: ["composer"],
      clickSubmit: [true],
      confirm: [
        { state: "waiting" },
        { state: "sent", postUrl: "https://example.social/@me/1234", postId: "1234", detail: "Posted" },
      ],
    });

    assert.equal(outcome.kind, "published");
    assert.equal(outcome.postUrl, "https://example.social/@me/1234");
    assert.equal(outcome.postId, "1234");
  });

  test("a rejection from the network is reported as one", async () => {
    const { outcome } = await run({
      probe: ["composer"],
      clickSubmit: [true],
      confirm: [{ state: "error", detail: "Something went wrong." }],
    });

    assert.equal(outcome.kind, "rejected");
    assert.match(String(outcome.detail), /rejected the post/);
  });

  test("silence until the deadline is unconfirmed, never success", async () => {
    const { outcome } = await run({
      probe: ["composer"],
      clickSubmit: [true],
      confirm: [{ state: "waiting" }],
    });

    assertUnconfirmed(outcome);
    assert.match(String(outcome.detail), /not be retried automatically/);
  });

  test("a login demanded right after submitting leaves the outcome unknown", async () => {
    // The post may already have gone out. Calling this a failure would invite a
    // retry, and a retry could double-post.
    const { outcome } = await run({
      probe: ["composer"],
      clickSubmit: [true],
      confirm: [{ state: "login" }],
    });

    assertUnconfirmed(outcome);
    assert.match(String(outcome.detail), /unknown/);
  });

  test("an attachment goes on before the post is submitted, never after", async () => {
    const { outcome, calls } = await run(
      { probe: ["composer"], clickSubmit: [true], confirm: [{ state: "sent" }] },
      { media: ["/data/media/abc/photo.jpg"] },
    );

    assert.equal(outcome.kind, "published");
    const attached = calls.indexOf("attachMedia:/data/media/abc/photo.jpg");
    const submitted = calls.indexOf("clickSubmit");
    assert.ok(attached >= 0, "the file must actually be attached");
    assert.ok(
      attached < submitted,
      "submitting before the file is attached posts the words without the picture",
    );
  });

  test("a post waits for the network to finish taking the file", async () => {
    const { outcome, calls } = await run(
      {
        probe: ["composer"],
        mediaReady: [false, false, true],
        clickSubmit: [true],
        confirm: [{ state: "sent" }],
      },
      { media: ["/data/media/abc/photo.jpg"] },
    );

    assert.equal(outcome.kind, "published");
    const lastReady = calls.lastIndexOf("mediaReady");
    assert.ok(
      lastReady < calls.indexOf("clickSubmit"),
      "an upload still in flight must not be submitted",
    );
  });

  test("an upload that never lands is a refusal, not a text-only post", async () => {
    const { outcome, calls } = await run(
      { probe: ["composer"], mediaReady: [false] },
      { media: ["/data/media/abc/photo.jpg"] },
    );

    assert.equal(outcome.kind, "rejected");
    assert.ok(
      !calls.includes("clickSubmit"),
      "nothing may be submitted once the attachment is known to be missing",
    );
  });

  test("a file that could not be attached stops the post", async () => {
    const { outcome, calls } = await run(
      {
        probe: ["composer"],
        attachMedia: { ok: false, detail: "No file input matched." },
        clickSubmit: [true],
        confirm: [{ state: "sent" }],
      },
      { media: ["/data/media/abc/photo.jpg"] },
    );

    assert.equal(outcome.kind, "rejected");
    assert.match(outcome.detail, /No file input matched/);
    assert.ok(!calls.includes("clickSubmit"), "a failed attachment must not post the text alone");
  });

  test("a network with no upload control refuses a post that carries one", async () => {
    const { outcome, calls } = await run(
      { probe: ["composer"], clickSubmit: [true], confirm: [{ state: "sent" }] },
      { media: ["/data/media/abc/photo.jpg"], canAttach: false },
    );

    assert.equal(outcome.kind, "rejected");
    assert.ok(!calls.includes("clickSubmit"), "the text alone is not the approved post");
  });

  test("a text-only post never touches the upload path", async () => {
    const { outcome, calls } = await run({
      probe: ["composer"],
      clickSubmit: [true],
      confirm: [{ state: "sent" }],
    });

    assert.equal(outcome.kind, "published");
    assert.ok(
      !calls.some((call) => call.startsWith("attachMedia") || call === "mediaReady"),
      "adding attachments must not change how a plain post behaves",
    );
  });

  test("a network that needs a picture refuses a post with none", async () => {
    const { outcome, calls } = await run(
      { probe: ["composer"], clickSubmit: [true], confirm: [{ state: "sent" }] },
      { mediaRequired: true, media: [] },
    );

    assert.equal(outcome.kind, "rejected");
    assert.match(outcome.detail, /without an image or video/);
    assert.equal(calls.length, 0, "nothing should even be opened");
  });

  test("an upload-first network waits for the upload control, not a caption box", async () => {
    const { outcome, calls } = await run(
      {
        probeUpload: ["composer"],
        probe: ["composer"],
        clickSubmit: [true],
        confirm: [{ state: "sent" }],
      },
      { mediaFirst: true, mediaRequired: true, media: ["/data/media/abc/photo.jpg"] },
    );

    assert.equal(outcome.kind, "published");
    assert.ok(calls.includes("probeUpload"), "the upload control is what gates the start");
    const firstProbeUpload = calls.indexOf("probeUpload");
    const attached = calls.indexOf("attachMedia:/data/media/abc/photo.jpg");
    assert.ok(firstProbeUpload < attached);
  });

  test("an upload-first network types the caption only after the picture is in", async () => {
    const { outcome, calls } = await run(
      {
        probeUpload: ["composer"],
        probe: ["composer"],
        clickSubmit: [true],
        confirm: [{ state: "sent" }],
      },
      { mediaFirst: true, media: ["/data/media/abc/photo.jpg"] },
    );

    assert.equal(outcome.kind, "published");
    const attached = calls.indexOf("attachMedia:/data/media/abc/photo.jpg");
    const typed = calls.findIndex((call) => call.startsWith("enterText"));
    assert.ok(typed > attached, "there is nowhere to type until the file is in");
  });

  test("the screens between upload and caption are walked in order", async () => {
    const { outcome, calls } = await run(
      {
        probeUpload: ["composer"],
        probe: ["composer"],
        clickSubmit: [true],
        confirm: [{ state: "sent" }],
      },
      {
        mediaFirst: true,
        media: ["/data/media/abc/photo.jpg"],
        afterAttach: [
          { click: "#crop-next", waitFor: "#filter-screen", label: "crop" },
          { click: "#filter-next", waitFor: "#caption-screen", label: "filter" },
        ],
      },
    );

    assert.equal(outcome.kind, "published");
    const order = [
      calls.indexOf("advance:#crop-next"),
      calls.indexOf("present:#filter-screen"),
      calls.indexOf("advance:#filter-next"),
      calls.indexOf("present:#caption-screen"),
      calls.findIndex((call) => call.startsWith("enterText")),
    ];
    assert.ok(
      order.every((position, index) => position >= 0 && (index === 0 || position > order[index - 1]!)),
      `steps ran out of order: ${JSON.stringify(order)}`,
    );
  });

  test("a step whose control never appears names the step that failed", async () => {
    const { outcome, calls } = await run(
      { probeUpload: ["composer"], probe: ["composer"], advance: [false] },
      {
        mediaFirst: true,
        media: ["/data/media/abc/photo.jpg"],
        afterAttach: [{ click: "#crop-next", waitFor: "#filter-screen", label: "crop" }],
      },
    );

    assert.equal(outcome.kind, "rejected");
    assert.match(outcome.detail, /crop/, "the operator should know which screen stalled");
    assert.ok(!calls.includes("clickSubmit"));
  });

  test("a step that clicks but never advances is not treated as progress", async () => {
    const { outcome, calls } = await run(
      {
        probeUpload: ["composer"],
        probe: ["composer"],
        advance: [true],
        present: [false],
      },
      {
        mediaFirst: true,
        media: ["/data/media/abc/photo.jpg"],
        afterAttach: [{ click: "#crop-next", waitFor: "#filter-screen", label: "crop" }],
      },
    );

    assert.equal(outcome.kind, "rejected");
    assert.match(outcome.detail, /did not move past its crop step/);
    assert.ok(!calls.includes("clickSubmit"));
  });

  test("an upload-first network with no caption field posts nothing", async () => {
    const { outcome, calls } = await run(
      { probeUpload: ["composer"], probe: ["waiting"] },
      { mediaFirst: true, media: ["/data/media/abc/photo.jpg"] },
    );

    assert.equal(outcome.kind, "rejected");
    assert.match(outcome.detail, /never showed a caption field/);
    assert.ok(!calls.includes("clickSubmit"));
  });
});
