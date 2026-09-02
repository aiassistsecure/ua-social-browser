import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { GetSessionStatusResponse, PublishPostBody } from "@workspace/api-zod";
import { publishThroughSession, readSessionStatus } from "../lib/session-bridge";
import { readBrowserState } from "../lib/browser-store";
import { TenantResolutionError, resolveTenantId } from "../lib/tenant";

const router: IRouter = Router();

type StoredDraft = {
  id: string;
  workspaceId: string;
  platform: string;
  body: string;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
};

function asStoredDraft(value: unknown): StoredDraft | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as Record<string, unknown>;
  if (typeof draft.id !== "string") return null;
  return {
    id: draft.id,
    workspaceId: typeof draft.workspaceId === "string" ? draft.workspaceId : "",
    platform: typeof draft.platform === "string" ? draft.platform : "",
    body: typeof draft.body === "string" ? draft.body : "",
    status: typeof draft.status === "string" ? draft.status : "",
    approvedBy: typeof draft.approvedBy === "string" ? draft.approvedBy : null,
    approvedAt: typeof draft.approvedAt === "string" ? draft.approvedAt : null,
  };
}

/** Statuses that mean a person has signed this draft off. */
const APPROVED_STATUSES = new Set([
  "approved",
  "scheduled",
  "publishing",
  "failed",
]);

type ApprovalCheck = { ok: true; draft: StoredDraft } | { ok: false; detail: string };

/**
 * Checks the approval against the stored draft rather than the request.
 *
 * The caller asserting `approval` in its own body proves nothing: whoever sends
 * the request writes those fields. The only trustworthy record of a human
 * sign-off is the one already in the ledger, put there by the workspace UI, so
 * that is what decides whether anything leaves. The submitted body must match
 * the approved text too — otherwise an approved draft id becomes a licence to
 * post anything.
 */
function verifyApproval(
  tenantId: string,
  input: {
    workspaceId: string;
    draftId: string;
    platform: string;
    body: string;
    approval: { approvedBy: string; approvedAt: string };
  },
): ApprovalCheck {
  const state = readBrowserState(tenantId);
  if (!state) {
    return { ok: false, detail: "No workspace state is stored yet, so nothing has been approved." };
  }

  const draft = state.drafts.map(asStoredDraft).find((entry) => entry?.id === input.draftId);
  if (!draft) {
    return {
      ok: false,
      detail: `Draft ${input.draftId} is not in this workspace's ledger. Only a stored, approved draft can be published.`,
    };
  }

  if (!APPROVED_STATUSES.has(draft.status) || !draft.approvedBy?.trim() || !draft.approvedAt?.trim()) {
    return {
      ok: false,
      detail: "That draft has not been approved by a person. Approve it in the review queue first.",
    };
  }

  if (draft.workspaceId !== input.workspaceId) {
    return { ok: false, detail: "That draft was approved for a different workspace." };
  }

  if (draft.platform !== input.platform) {
    return { ok: false, detail: "That draft was approved for a different network." };
  }

  if (draft.body !== input.body) {
    return {
      ok: false,
      detail: "The submitted text does not match the approved draft. Approve the edited version first.",
    };
  }

  const assertedBy = input.approval.approvedBy.trim();
  const assertedAt = input.approval.approvedAt.trim();
  if (assertedBy !== draft.approvedBy.trim() || assertedAt !== draft.approvedAt.trim()) {
    return {
      ok: false,
      detail: "The approval in this request disagrees with the recorded sign-off.",
    };
  }

  return { ok: true, draft };
}

router.get("/session/status", async (req, res) => {
  const workspaceId = req.query.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
    return res.status(400).json({ error: "workspaceId is required" });
  }

  const status = await readSessionStatus(workspaceId);
  return res.json(GetSessionStatusResponse.parse(status));
});

router.post("/publish", async (req, res) => {
  const parsed = PublishPostBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid publish request" });
  }

  const input = parsed.data;

  // The approval is the whole point of the product: a model may draft, but a
  // person signs. No approval, no network call. The sign-off is read from the
  // stored ledger, never from the request that wants to publish.
  let tenantId: string;
  try {
    tenantId = resolveTenantId(req);
  } catch (error) {
    if (error instanceof TenantResolutionError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }

  const approval = verifyApproval(tenantId, input);
  if (!approval.ok) {
    req.log.warn(
      { workspaceId: input.workspaceId, draftId: input.draftId },
      "Refused a publish request with no recorded human approval",
    );
    return res.status(409).json({ error: approval.detail });
  }

  const attemptedAt = new Date().toISOString();
  const outcome = await publishThroughSession({
    workspaceId: input.workspaceId,
    draftId: input.draftId,
    platform: input.platform,
    body: input.body,
    idempotencyKey: input.idempotencyKey ?? randomUUID(),
  });

  const base = {
    draftId: input.draftId,
    platform: input.platform,
    attemptedAt,
  };

  switch (outcome.kind) {
    case "published":
      req.log.info(
        { workspaceId: input.workspaceId, draftId: input.draftId },
        "Published through workspace session",
      );
      return res.json({
        ...base,
        status: "published" as const,
        postUrl: outcome.postUrl,
        postId: outcome.postId,
        message: "Posted from your own signed-in session.",
      });

    case "unauthenticated":
      return res.status(409).json({
        ...base,
        status: "failed" as const,
        message: outcome.detail,
      });

    case "rejected":
      return res.status(502).json({
        ...base,
        status: "failed" as const,
        message: outcome.detail,
      });

    case "unavailable":
      return res.status(503).json({
        ...base,
        status: "failed" as const,
        message: outcome.detail,
      });
  }
});

export default router;
