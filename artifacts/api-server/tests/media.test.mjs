import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { approvedAt, draft, startStack } from "./helpers/stack.mjs";

/**
 * What an attachment is allowed to do.
 *
 * The rule these guard is the same one the text has always been held to: an
 * approval is for exact content. Once a post can carry a picture, "exact
 * content" includes which picture — so an approved draft id must not become a
 * licence to publish any image, and the file that reaches the network must be
 * the file that was signed off.
 */

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001" +
    "0d0a2db40000000049454e44ae426082",
  "hex",
);
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");

async function upload(base, bytes, filename, type = "image/png") {
  const response = await fetch(`${base}/media`, {
    method: "POST",
    headers: { "Content-Type": type, "x-filename": filename },
    body: bytes,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

describe("storing an upload", () => {
  let stack;

  before(async () => {
    stack = await startStack();
  });
  after(() => stack.stop());

  it("addresses the file by the hash of its own bytes", async () => {
    const { status, body } = await upload(stack.base, PNG, "photo.png");

    assert.equal(status, 201);
    assert.equal(body.media.sha256, PNG_SHA);
    assert.equal(body.media.id, `${PNG_SHA}/photo.png`);
    assert.equal(body.media.bytes, PNG.length);
  });

  it("never hands the browser a filesystem path", async () => {
    const { body } = await upload(stack.base, PNG, "photo.png");
    assert.equal(body.media.path, undefined, "a path is the shell's business, not the page's");
  });

  it("gives the same bytes the same address twice", async () => {
    const first = await upload(stack.base, PNG, "photo.png");
    const second = await upload(stack.base, PNG, "photo.png");
    assert.equal(first.body.media.id, second.body.media.id);
  });

  it("refuses a type this build cannot upload, rather than storing it", async () => {
    const { status } = await upload(
      stack.base,
      Buffer.from("%PDF-1.4"),
      "contract.pdf",
      "application/pdf",
    );
    assert.equal(status, 400);
  });

  it("refuses an upload with no filename, because the network shows that name", async () => {
    const response = await fetch(`${stack.base}/media`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: PNG,
    });
    assert.equal(response.status, 400);
  });

  it("reads the bytes back unchanged for preview", async () => {
    const { body } = await upload(stack.base, PNG, "photo.png");
    const response = await fetch(`${stack.base}/media/${body.media.id}`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  });

  it("answers 404 for an address nothing was ever stored at", async () => {
    const response = await fetch(`${stack.base}/media/${"a".repeat(64)}/ghost.png`);
    assert.equal(response.status, 404);
  });

  it("refuses an address that tries to leave the media directory", async () => {
    const response = await fetch(
      `${stack.base}/media/${encodeURIComponent("../../..")}/${encodeURIComponent("passwd")}`,
    );
    assert.ok(response.status >= 400, `expected a refusal, got ${response.status}`);
  });
});

describe("publishing a post that carries a picture", () => {
  let stack;
  let media;

  before(async () => {
    stack = await startStack();
    media = (await upload(stack.base, PNG, "photo.png")).body.media;

    await stack.putState([
      draft("with-media", {
        status: "approved",
        scheduledFor: null,
        media: [{ ...media, altText: "a single pixel" }],
      }),
    ]);
  });
  after(() => stack.stop());

  it("hands the shell a path and a checksum, never the bytes", async () => {
    const { status } = await stack.publish({
      workspaceId: "ws-1",
      draftId: "with-media",
      platform: "x",
      body: "body of with-media",
      media: [{ ...media, altText: "a single pixel" }],
      approval: { approvedBy: "Ada", approvedAt },
    });

    assert.equal(status, 200);
    const sent = stack.shell.received.at(-1);
    assert.equal(sent.media.length, 1);
    assert.equal(sent.media[0].sha256, PNG_SHA);
    assert.equal(sent.media[0].altText, "a single pixel");
    assert.ok(sent.media[0].path.endsWith(`${PNG_SHA}/photo.png`));
    assert.equal(sent.media[0].bytes, undefined, "the shell needs a path, not a size");
  });
});

describe("an approval covers the picture, not just the words", () => {
  let stack;
  let approvedImage;
  let otherImage;

  before(async () => {
    stack = await startStack();
    approvedImage = (await upload(stack.base, PNG, "approved.png")).body.media;
    otherImage = (await upload(stack.base, Buffer.concat([PNG, Buffer.from("x")]), "other.png"))
      .body.media;

    await stack.putState([
      draft("signed", { status: "approved", scheduledFor: null, media: [approvedImage] }),
      draft("no-media", { status: "approved", scheduledFor: null, media: [] }),
    ]);
  });
  after(() => stack.stop());

  it("refuses a publish that swaps in a different picture", async () => {
    const before = stack.shell.received.length;
    const { status, body } = await stack.publish({
      workspaceId: "ws-1",
      draftId: "signed",
      platform: "x",
      body: "body of signed",
      media: [otherImage],
      approval: { approvedBy: "Ada", approvedAt },
    });

    assert.equal(status, 409);
    assert.match(body.error, /attachments/i);
    assert.equal(stack.shell.received.length, before, "nothing may reach the shell");
  });

  it("refuses a publish that quietly drops the approved picture", async () => {
    const before = stack.shell.received.length;
    const { status } = await stack.publish({
      workspaceId: "ws-1",
      draftId: "signed",
      platform: "x",
      body: "body of signed",
      media: [],
      approval: { approvedBy: "Ada", approvedAt },
    });

    assert.equal(status, 409);
    assert.equal(stack.shell.received.length, before);
  });

  it("refuses a publish that adds a picture to a text-only approval", async () => {
    const before = stack.shell.received.length;
    const { status } = await stack.publish({
      workspaceId: "ws-1",
      draftId: "no-media",
      platform: "x",
      body: "body of no-media",
      media: [otherImage],
      approval: { approvedBy: "Ada", approvedAt },
    });

    assert.equal(status, 409);
    assert.equal(stack.shell.received.length, before);
  });

  it("refuses a publish that only changes the alt text", async () => {
    const before = stack.shell.received.length;
    const { status } = await stack.publish({
      workspaceId: "ws-1",
      draftId: "signed",
      platform: "x",
      body: "body of signed",
      media: [{ ...approvedImage, altText: "something the approver never wrote" }],
      approval: { approvedBy: "Ada", approvedAt },
    });

    assert.equal(status, 409, "alt text is published content");
    assert.equal(stack.shell.received.length, before);
  });

  it("lets the approved picture through unchanged", async () => {
    const { status } = await stack.publish({
      workspaceId: "ws-1",
      draftId: "signed",
      platform: "x",
      body: "body of signed",
      media: [approvedImage],
      approval: { approvedBy: "Ada", approvedAt },
    });

    assert.equal(status, 200);
    assert.equal(stack.shell.received.at(-1).media[0].sha256, approvedImage.sha256);
  });
});

describe("a scheduled post that carries a picture", () => {
  let stack;

  before(async () => {
    stack = await startStack();
    const media = (await upload(stack.base, PNG, "scheduled.png")).body.media;
    await stack.putState([draft("due-with-media", { media: [media] })]);
    await stack.settle();
  });
  after(() => stack.stop());

  it("sends the attachment too, not just the text", async () => {
    const sent = stack.shell.received.find((r) => r.draftId === "due-with-media");
    assert.ok(sent, "the scheduler should have sent it");
    assert.equal(sent.media.length, 1);
    assert.equal(sent.media[0].sha256, PNG_SHA);
  });
});
