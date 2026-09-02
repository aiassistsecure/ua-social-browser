import path from "node:path";
import { mkdirSync } from "node:fs";
import { NedbCore } from "nedb-engine";

const dataDirectory =
  process.env.NEDB_DATA_DIR ??
  path.join(process.cwd(), ".data", "ua-social-browser");

mkdirSync(dataDirectory, { recursive: true });

const db = NedbCore.open(dataDirectory);
const COLLECTION = "browser_state";
const DOCUMENT_ID = "primary";

export type BrowserStateDocument = {
  version: number;
  activeWorkspaceId: string;
  workspaces: unknown[];
  uaProfiles: unknown[];
  drafts: unknown[];
  accounts: unknown[];
  activity: unknown[];
  settings: Record<string, unknown>;
  usage: Record<string, unknown>;
  updatedAt: string;
};

export function readBrowserState(): BrowserStateDocument | null {
  const document = db.get(COLLECTION, DOCUMENT_ID);
  return document ? (JSON.parse(document) as BrowserStateDocument) : null;
}

export function writeBrowserState(state: BrowserStateDocument) {
  const stored = JSON.parse(
    db.put(
      COLLECTION,
      DOCUMENT_ID,
      JSON.stringify({ ...state, updatedAt: new Date().toISOString() }),
    ),
  ) as BrowserStateDocument;
  db.flush();
  return stored;
}

export function getStoreHealth() {
  return {
    verified: db.verify(),
    sequence: Number(db.seq()),
    head: db.head(),
    dataDirectory,
  };
}

export function exportStoreHistory() {
  const tip = db.tipCollection(COLLECTION);
  return {
    state: readBrowserState(),
    integrity: getStoreHealth(),
    tip: tip ? JSON.parse(tip) : null,
  };
}