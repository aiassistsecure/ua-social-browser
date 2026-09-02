import { readBrowserState } from "./browser-store";

/**
 * The stored copy of a draft — the only version of a post that may be sent.
 *
 * The browser holds the working copy and posts a request when a person presses
 * Post, but a request is a claim about a draft, not the draft itself. Both
 * dispatch paths read the post out of storage instead, so what leaves is what
 * was actually approved and saved, and a revocation written before the send is
 * seen by both of them alike.
 */

export type StoredDraft = {
  id: string;
  workspaceId: string;
  platform: string;
  body: string;
  status: string;
  scheduledFor: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
};

export function asStoredDraft(value: unknown): StoredDraft | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as Record<string, unknown>;
  if (typeof draft.id !== "string" || typeof draft.status !== "string") {
    return null;
  }
  return {
    id: draft.id,
    workspaceId: typeof draft.workspaceId === "string" ? draft.workspaceId : "",
    platform: typeof draft.platform === "string" ? draft.platform : "",
    body: typeof draft.body === "string" ? draft.body : "",
    status: draft.status,
    scheduledFor:
      typeof draft.scheduledFor === "string" ? draft.scheduledFor : null,
    approvedBy: typeof draft.approvedBy === "string" ? draft.approvedBy : null,
    approvedAt: typeof draft.approvedAt === "string" ? draft.approvedAt : null,
  };
}

export function readStoredDraft(
  tenantId: string,
  draftId: string,
): StoredDraft | null {
  const state = readBrowserState(tenantId);
  if (!state) return null;

  for (const candidate of state.drafts) {
    const draft = asStoredDraft(candidate);
    if (draft?.id === draftId) return draft;
  }
  return null;
}

/** True when a person has signed this exact version of the post. */
export function isApproved(
  draft: StoredDraft,
): draft is StoredDraft & { approvedBy: string; approvedAt: string } {
  return Boolean(draft.approvedBy?.trim() && draft.approvedAt?.trim());
}
