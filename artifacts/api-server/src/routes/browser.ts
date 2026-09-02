import { Router, type IRouter, type Request, type Response } from "express";
import {
  exportStoreHistory,
  getStoreHealth,
  readBrowserState,
  writeBrowserState,
  type BrowserStateDocument,
} from "../lib/browser-store";
import {
  TenantResolutionError,
  resolveTenantId,
  tenancyMode,
  tenantLabel,
} from "../lib/tenant";

const router: IRouter = Router();

function isBrowserState(value: unknown): value is BrowserStateDocument {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.version === "number" &&
    typeof state.activeWorkspaceId === "string" &&
    Array.isArray(state.workspaces) &&
    Array.isArray(state.uaProfiles) &&
    Array.isArray(state.drafts) &&
    Array.isArray(state.accounts) &&
    Array.isArray(state.activity) &&
    typeof state.settings === "object" &&
    typeof state.usage === "object"
  );
}

/** Resolves the tenant or writes the 401 and returns null. */
function tenantOrUnauthorized(req: Request, res: Response): string | null {
  try {
    return resolveTenantId(req);
  } catch (error) {
    if (error instanceof TenantResolutionError) {
      res.status(error.status).json({ error: error.message });
      return null;
    }
    throw error;
  }
}

router.get("/tenant", (req, res): void => {
  const tenantId = tenantOrUnauthorized(req, res);
  if (!tenantId) return;
  res.json({
    id: tenantId,
    mode: tenancyMode(),
    label: tenantLabel(tenantId),
  });
});

router.get("/browser/state", (req, res): void => {
  const tenantId = tenantOrUnauthorized(req, res);
  if (!tenantId) return;
  res.json({
    state: readBrowserState(tenantId),
    integrity: getStoreHealth(),
  });
});

router.put("/browser/state", (req, res): void => {
  const tenantId = tenantOrUnauthorized(req, res);
  if (!tenantId) return;

  if (!isBrowserState(req.body)) {
    res.status(400).json({ error: "Invalid browser state" });
    return;
  }

  res.json({
    state: writeBrowserState(tenantId, req.body),
    integrity: getStoreHealth(),
  });
});

router.get("/browser/integrity", (_req, res): void => {
  res.json(getStoreHealth());
});

router.get("/browser/export", (req, res): void => {
  const tenantId = tenantOrUnauthorized(req, res);
  if (!tenantId) return;

  res.setHeader(
    "Content-Disposition",
    'attachment; filename="ua-social-browser-export.json"',
  );
  res.json(exportStoreHistory(tenantId));
});

export default router;
