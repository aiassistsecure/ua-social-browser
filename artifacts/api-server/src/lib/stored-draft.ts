import { readBrowserState } from "./browser-store";
import type { MediaRef } from "./media-store";

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
  /** References only. The bytes are on disk; see `media-store.ts`. */
  media: MediaRef[];
};

/**
 * Reads attachments off a stored draft without trusting their shape.
 *
 * A malformed entry is dropped rather than repaired: half a reference cannot
 * identify a file, and a publish that silently posted fewer pictures than were
 * approved would be a quieter version of posting the wrong thing.
 */
function asMediaRefs(value: unknown): MediaRef[] {
  if (!Array.isArray(value)) return [];
  const refs: MediaRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      typeof item.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(item.sha256) ||
      typeof item.filename !== "string" ||
      typeof item.mimeType !== "string" ||
      typeof item.bytes !== "number"
    ) {
      continue;
    }
    refs.push({
      id: item.id,
      sha256: item.sha256,
      filename: item.filename,
      mimeType: item.mimeType,
      bytes: item.bytes,
      ...(typeof item.altText === "string" ? { altText: item.altText } : {}),
    });
  }
  return refs;
}

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
    media: asMediaRefs(draft.media),
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
