import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { GetSessionStatusResponse, PublishPostBody } from "@workspace/api-zod";
import { publishThroughSession, readSessionStatus } from "../lib/session-bridge";

const router: IRouter = Router();

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
  // person signs. No approval, no network call.
  if (!input.approval.approvedBy.trim() || !input.approval.approvedAt.trim()) {
    return res
      .status(409)
      .json({ error: "A human approval is required before publishing" });
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
