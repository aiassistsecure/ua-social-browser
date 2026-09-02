import { Router, type IRouter } from "express";
import {
  exportStoreHistory,
  getStoreHealth,
  readBrowserState,
  writeBrowserState,
  type BrowserStateDocument,
} from "../lib/browser-store";

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

router.get("/browser/state", (_req, res): void => {
  res.json({ state: readBrowserState(), integrity: getStoreHealth() });
});

router.put("/browser/state", (req, res): void => {
  if (!isBrowserState(req.body)) {
    res.status(400).json({ error: "Invalid browser state" });
    return;
  }
  res.json({ state: writeBrowserState(req.body), integrity: getStoreHealth() });
});

router.get("/browser/integrity", (_req, res): void => {
  res.json(getStoreHealth());
});

router.get("/browser/export", (_req, res): void => {
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="ua-social-browser-export.json"',
  );
  res.json(exportStoreHistory());
});

export default router;