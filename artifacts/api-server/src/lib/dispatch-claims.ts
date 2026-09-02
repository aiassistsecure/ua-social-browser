/**
 * Claims over drafts that are being sent right now.
 *
 * A scheduled post is decided by two actors that do not know about each other:
 * the scheduler, and the person editing drafts in the browser. Between the
 * moment the scheduler decides a draft is eligible and the moment the platform
 * accepts it, that person may edit the text or take their approval back. A post
 * is not recallable, so this seam has to be exact.
 *
 * The rule:
 *
 * - The scheduler re-reads the stored draft and takes a claim in one
 *   synchronous step, with no await in between. A revocation that is written
 *   before that step is therefore always seen, and the post is skipped.
 * - While a claim is held, the stored copy of that draft is authoritative. A
 *   state write that would change it is refused for that draft and the browser
 *   is told, because by then the post is already on its way out and pretending
 *   otherwise would be a lie.
 *
 * Claims are process-local, which is correct here: the scheduler and the API
 * live in the same process, and posting itself is confined to the one machine
 * holding the session.
 */

export type DispatchClaim = {
  tenantId: string;
  draftId: string;
  approvedAt: string;
  claimedAt: string;
};

const claims = new Map<string, DispatchClaim>();

function claimKey(tenantId: string, draftId: string): string {
  return `${tenantId}:${draftId}`;
}

/** Takes the claim, or returns null when the draft is already being sent. */
export function takeClaim(
  tenantId: string,
  draftId: string,
  approvedAt: string,
): DispatchClaim | null {
  const key = claimKey(tenantId, draftId);
  if (claims.has(key)) return null;

  const claim: DispatchClaim = {
    tenantId,
    draftId,
    approvedAt,
    claimedAt: new Date().toISOString(),
  };
  claims.set(key, claim);
  return claim;
}

export function releaseClaim(claim: DispatchClaim): void {
  claims.delete(claimKey(claim.tenantId, claim.draftId));
}

export function claimedDraftIds(tenantId: string): Set<string> {
  const ids = new Set<string>();
  for (const claim of claims.values()) {
    if (claim.tenantId === tenantId) ids.add(claim.draftId);
  }
  return ids;
}
