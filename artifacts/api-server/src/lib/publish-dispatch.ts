import {
  findDispatch,
  recordDispatch,
  updateDispatch,
  type DispatchRecord,
  type DispatchSource,
} from "./dispatch-log";
import { resolveMedia, type MediaRef } from "./media-store";
import { publishThroughSession, type BridgePublishInput } from "./session-bridge";

/**
 * The single door a post leaves through.
 *
 * Both the manual route and the scheduler call this. Putting them behind one
 * function is what makes the idempotency key mean something: whichever of the
 * two arrives first does the work, and the other one is handed that same
 * result instead of making a second network call.
 */

export type DispatchRequest = {
  tenantId: string;
  workspaceId: string;
  draftId: string;
  platform: string;
  body: string;
  /** Attachments as recorded on the approved draft, in posting order. */
  media?: MediaRef[];
  approval: { approvedBy: string; approvedAt: string };
  source: DispatchSource;
  /** Set by the scheduler: the send time this attempt is being made for. */
  scheduledFor?: string;
};

/** Mirrors the shape the manual route already reported to the browser. */
export type DispatchFailureReason =
  | "approval-missing"
  | "unauthenticated"
  | "rejected"
  | "unavailable";

export type DispatchOutcome = {
  status: "published" | "failed";
  reason: DispatchFailureReason | null;
  message: string;
  postUrl?: string;
  postId?: string;
  attemptedAt: string;
  idempotencyKey: string;
  /** True when no network call was made because this key already has a result. */
  replayed: boolean;
};

/**
 * The identity of a post, as far as sending is concerned.
 *
 * The approval timestamp is part of it on purpose: editing a draft clears its
 * approval, so re-approved text is a genuinely new post rather than a retry of
 * the old one.
 *
 * It is always derived here, never taken from the caller. A key that a caller
 * could choose is not an idempotency key at all — two requests for the same
 * post under two invented keys would each look brand new and each post.
 */
export function idempotencyKeyFor(draftId: string, approvedAt: string): string {
  return `${draftId}:${approvedAt}`;
}

/** In-process coalescing, so a scheduler tick and a button press cannot both post. */
const inFlight = new Map<string, Promise<DispatchOutcome>>();

type ResolvedAttachments =
  | { ok: true; media: NonNullable<BridgePublishInput["media"]> }
  | { ok: false; detail: string };

/**
 * Turns stored references into the paths the shell will upload.
 *
 * A missing file fails the whole dispatch rather than posting what is left. A
 * post with one of its three pictures silently dropped is a different post
 * from the one that was approved, and the operator would have no way to know
 * from the result that anything was missing.
 */
function resolveAttachments(
  tenantId: string,
  media: readonly MediaRef[] | undefined,
): ResolvedAttachments {
  if (!media || media.length === 0) return { ok: true, media: [] };

  const resolved: NonNullable<BridgePublishInput["media"]> = [];
  for (const ref of media) {
    const stored = resolveMedia(tenantId, ref.id);
    if (!stored || stored.sha256 !== ref.sha256) {
      return {
        ok: false,
        detail: `The attachment "${ref.filename}" is missing from this app's storage, so nothing was posted. Re-attach it and approve again.`,
      };
    }
    resolved.push({
      path: stored.path,
      sha256: stored.sha256,
      filename: stored.filename,
      mimeType: stored.mimeType,
      ...(ref.altText ? { altText: ref.altText } : {}),
    });
  }
  return { ok: true, media: resolved };
}

/** Replays an already-published dispatch without touching the network again. */
function replayPublished(record: DispatchRecord): DispatchOutcome {
  return {
    status: "published",
    reason: null,
    message: record.message,
    postUrl: record.postUrl,
    postId: record.postId,
    attemptedAt: record.dispatchedAt,
    idempotencyKey: record.idempotencyKey,
    replayed: true,
  };
}

async function performDispatch(
  request: DispatchRequest,
  idempotencyKey: string,
): Promise<DispatchOutcome> {
  const attemptedAt = new Date().toISOString();

  // Resolved before the intent is written: a dispatch that cannot assemble its
  // own attachments never happened, and should not leave a "sending" record
  // for a post that was never handed to anything.
  const attachments = resolveAttachments(request.tenantId, request.media);
  if (!attachments.ok) {
    return {
      status: "failed",
      reason: "rejected",
      message: attachments.detail,
      attemptedAt,
      idempotencyKey,
      replayed: false,
    };
  }

  // Written down before the call, not after. A post cannot be recalled, so the
  // dangerous state is having sent one with nothing on disk saying so: the
  // process dies, the log is empty, and the next pass sends it again. The
  // intent goes down first and is resolved to what happened; if this process
  // never gets to resolve it, the next start marks it uncertain and leaves it
  // to a person.
  const intent = recordDispatch(request.tenantId, {
    idempotencyKey,
    draftId: request.draftId,
    workspaceId: request.workspaceId,
    platform: request.platform,
    approvedBy: request.approval.approvedBy,
    approvedAt: request.approval.approvedAt,
    scheduledFor: request.scheduledFor,
    status: "sending",
    message: "Handed to your signed-in session.",
    source: request.source,
    dispatchedAt: attemptedAt,
  });

  const outcome = await publishThroughSession({
    workspaceId: request.workspaceId,
    draftId: request.draftId,
    platform: request.platform,
    body: request.body,
    media: attachments.media,
    idempotencyKey,
  });

  if (outcome.kind === "published") {
    const message = "Posted from your own signed-in session.";
    updateDispatch(request.tenantId, intent.seq, {
      status: "published",
      message,
      postUrl: outcome.postUrl,
      postId: outcome.postId,
    });
    return {
      status: "published",
      reason: null,
      message,
      postUrl: outcome.postUrl,
      postId: outcome.postId,
      attemptedAt,
      idempotencyKey,
      replayed: false,
    };
  }

  // A failure is written down too. It is what stops the scheduler retrying
  // this approval forever, and it is how the browser learns why a queued post
  // never went out. It does not block a person retrying by hand.
  updateDispatch(request.tenantId, intent.seq, {
    status: "failed",
    message: outcome.detail,
  });

  return {
    status: "failed",
    reason: outcome.kind,
    message: outcome.detail,
    attemptedAt,
    idempotencyKey,
    replayed: false,
  };
}

export async function dispatchApprovedPost(
  request: DispatchRequest,
): Promise<DispatchOutcome> {
  const approvedBy = request.approval.approvedBy.trim();
  const approvedAt = request.approval.approvedAt.trim();

  // The approval is the whole point of the product: a model may draft, but a
  // person signs. No approval, no network call — on either path.
  if (!approvedBy || !approvedAt) {
    return {
      status: "failed",
      reason: "approval-missing",
      message: "A human approval is required before publishing",
      attemptedAt: new Date().toISOString(),
      idempotencyKey: "",
      replayed: false,
    };
  }

  const idempotencyKey = idempotencyKeyFor(request.draftId, approvedAt);
  const scopedKey = `${request.tenantId}:${idempotencyKey}`;

  // A published record is terminal: the post is already out there. A failed
  // record is not — it stops the scheduler from trying again, but a person may.
  const settled = findDispatch(request.tenantId, idempotencyKey);
  if (settled?.status === "published") {
    return replayPublished(settled);
  }

  const running = inFlight.get(scopedKey);
  if (running) {
    return { ...(await running), replayed: true };
  }

  const attempt = performDispatch(request, idempotencyKey);
  inFlight.set(scopedKey, attempt);
  try {
    return await attempt;
  } finally {
    inFlight.delete(scopedKey);
  }
}
