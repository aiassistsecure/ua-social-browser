import { Router, type IRouter } from "express";
import { findOutcomes, listDispatches } from "../lib/dispatch-log";
import { schedulerStatus } from "../lib/scheduler";
import { tenantOrUnauthorized } from "../lib/tenant";

/**
 * What the scheduler did, and whether it can do anything at all.
 *
 * The browser owns its state document, so the scheduler reports outcomes here
 * rather than writing into it. The browser asks about the posts it is still
 * waiting on and folds the answers into the drafts it holds — which is how a
 * post that went out while the app was closed still shows up as posted when it
 * opens again, however long it was away.
 */

const router: IRouter = Router();

/** A tail for looking at what happened; not what reconciliation reads. */
const RECENT_DISPATCH_LIMIT = 50;

/** A workspace with more posts in flight than this is not a real workspace. */
const MAX_KEYS_PER_LOOKUP = 1000;

router.get("/schedule/status", (_req, res): void => {
  res.json(schedulerStatus());
});

router.get("/schedule/dispatches", (req, res): void => {
  const tenantId = tenantOrUnauthorized(req, res);
  if (!tenantId) return;

  res.json({
    now: new Date().toISOString(),
    dispatches: listDispatches(tenantId, RECENT_DISPATCH_LIMIT),
  });
});

/**
 * "These posts are still out of my hands — what happened to them?"
 *
 * Asking by name rather than reading a recent feed is what makes catching up
 * lossless: a browser that has been closed for a month asks about the same
 * handful of drafts it left behind and gets every one of their outcomes.
 */
router.post("/schedule/outcomes", (req, res): void => {
  const tenantId = tenantOrUnauthorized(req, res);
  if (!tenantId) return;

  const requested = (req.body as { keys?: unknown })?.keys;
  if (!Array.isArray(requested)) {
    res.status(400).json({ error: "Expected a list of keys" });
    return;
  }

  const keys = requested
    .filter((key): key is string => typeof key === "string" && key.length > 0)
    .slice(0, MAX_KEYS_PER_LOOKUP);

  res.json({
    now: new Date().toISOString(),
    outcomes: findOutcomes(tenantId, keys),
  });
});

export default router;
