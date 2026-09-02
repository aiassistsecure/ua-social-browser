import { db } from "./store";

/**
 * Durable record of every attempt to push a post through the session bridge.
 *
 * It exists for two reasons:
 *
 * 1. Idempotency. A published record under an idempotency key is terminal —
 *    the post is already out, so no path may send it a second time.
 * 2. Bounding the scheduler. The scheduler makes exactly one automatic attempt
 *    per (draft, approval): once a record exists for that key, it never picks
 *    the draft up again on its own. A person can still retry by hand.
 *
 * It is also what lets the browser find out what happened while it was closed:
 * the scheduler owns dispatch, the browser owns its state document, and this
 * log is the seam between them. Nothing here writes into the state document,
 * so the two never race over the same bytes.
 *
 * Nothing in it is ever pruned. A scheduled draft stays `scheduled` in the
 * browser's document until that browser reconciles it, which may be weeks
 * later, and the only thing standing between it and a second send is the record
 * saying it already went out. Dropping the oldest records to keep the log tidy
 * would mean the oldest unreconciled posts are the ones that get posted twice.
 * The log grows with posts actually sent, which is the same order as the drafts
 * the workspace keeps anyway.
 */

const COLLECTION = "publish_dispatches";

/**
 * `sending` is written before the bridge is called and replaced by the result.
 * If the process dies in between, that record is all that is left, and on the
 * next start it becomes `uncertain` rather than disappearing: the post may well
 * have gone out, and the one thing that must not happen is quietly sending it
 * again to find out.
 */
export type DispatchStatus = "sending" | "published" | "failed" | "uncertain";

export const UNCERTAIN_MESSAGE =
  "This post was handed to your signed-in session and the app stopped before it heard back. It may or may not have gone out — check the account before sending it again.";

/** Who asked for the post to go out. */
export type DispatchSource = "operator" | "scheduler";

export type DispatchRecord = {
  seq: number;
  idempotencyKey: string;
  draftId: string;
  workspaceId: string;
  platform: string;
  /** The approval this dispatch travelled under; a later approval is a new key. */
  approvedBy: string;
  approvedAt: string;
  /**
   * The send time this attempt was made for, when the scheduler made it. Moving
   * a post to a new time is a fresh instruction and earns a fresh attempt; the
   * idempotency key still stops that attempt posting anything twice.
   */
  scheduledFor?: string;
  status: DispatchStatus;
  message: string;
  postUrl?: string;
  postId?: string;
  source: DispatchSource;
  dispatchedAt: string;
};

type DispatchLogDocument = {
  nextSeq: number;
  records: DispatchRecord[];
};

function documentId(tenantId: string): string {
  return `dispatches:${tenantId}`;
}

function readLog(tenantId: string): DispatchLogDocument {
  const document = db.get(COLLECTION, documentId(tenantId));
  if (!document) return { nextSeq: 1, records: [] };

  const parsed = JSON.parse(document) as Partial<DispatchLogDocument>;
  return {
    nextSeq: typeof parsed.nextSeq === "number" ? parsed.nextSeq : 1,
    records: Array.isArray(parsed.records) ? parsed.records : [],
  };
}

function writeLog(tenantId: string, log: DispatchLogDocument): void {
  db.put(COLLECTION, documentId(tenantId), JSON.stringify(log));
  db.flush();
}

/** Most recent first. */
export function listDispatches(
  tenantId: string,
  limit = 50,
): DispatchRecord[] {
  const { records } = readLog(tenantId);
  return records.slice(-Math.max(1, limit)).reverse();
}

export function findDispatch(
  tenantId: string,
  idempotencyKey: string,
): DispatchRecord | null {
  const { records } = readLog(tenantId);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record && record.idempotencyKey === idempotencyKey) return record;
  }
  return null;
}

/**
 * Has this exact instruction — this approval, for this send time — already been
 * attempted? Used to bound automatic sending to one attempt per instruction.
 *
 * Deliberately blind to who made the attempt. A person pressing Post on a post
 * that is also due is that instruction being carried out; if it fails they are
 * looking at the reason and can decide. The scheduler quietly sending it again
 * afterwards would be a second, unasked-for send.
 */
export function findInstructionAttempt(
  tenantId: string,
  idempotencyKey: string,
  scheduledFor: string,
): DispatchRecord | null {
  const { records } = readLog(tenantId);
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (
      record &&
      record.idempotencyKey === idempotencyKey &&
      record.scheduledFor === scheduledFor
    ) {
      return record;
    }
  }
  return null;
}

/**
 * The outcome of each named instruction, for a browser catching up.
 *
 * The browser asks about exactly the drafts it is still waiting on, so catching
 * up after a week away costs the same as catching up after a minute, and no
 * outcome can fall off the end of a page and be missed. A published record wins
 * over a failed one for the same key: the post is out, and that is the truth
 * regardless of what was attempted before it.
 */
export function findOutcomes(
  tenantId: string,
  idempotencyKeys: string[],
): DispatchRecord[] {
  const wanted = new Set(idempotencyKeys);
  if (wanted.size === 0) return [];

  const { records } = readLog(tenantId);
  const outcomes = new Map<string, DispatchRecord>();

  for (const record of records) {
    if (!wanted.has(record.idempotencyKey)) continue;
    // Still in the air; there is nothing to tell the browser yet.
    if (record.status === "sending") continue;

    const existing = outcomes.get(record.idempotencyKey);
    if (existing?.status === "published") continue;
    outcomes.set(record.idempotencyKey, record);
  }

  return [...outcomes.values()].sort((a, b) => a.seq - b.seq);
}

export function recordDispatch(
  tenantId: string,
  entry: Omit<DispatchRecord, "seq">,
): DispatchRecord {
  const log = readLog(tenantId);
  const record: DispatchRecord = { ...entry, seq: log.nextSeq };

  writeLog(tenantId, {
    nextSeq: log.nextSeq + 1,
    records: [...log.records, record],
  });

  return record;
}

/** Replaces an intent with what actually happened, in place. */
export function updateDispatch(
  tenantId: string,
  seq: number,
  patch: Partial<Omit<DispatchRecord, "seq">>,
): DispatchRecord | null {
  const log = readLog(tenantId);
  let updated: DispatchRecord | null = null;

  const records = log.records.map((record) => {
    if (record.seq !== seq) return record;
    updated = { ...record, ...patch };
    return updated;
  });

  if (!updated) return null;
  writeLog(tenantId, { nextSeq: log.nextSeq, records });
  return updated;
}

/**
 * Called at startup: anything still marked `sending` belongs to a process that
 * died mid-send.
 *
 * The honest answer is that nobody knows whether the post went out, so it is
 * recorded as uncertain and left for a person. It still counts as this
 * instruction's attempt, so no loop picks it up and sends it a second time —
 * one unrecallable duplicate is worse than one post that needs checking.
 */
export function resolveInterruptedDispatches(tenantId: string): number {
  const log = readLog(tenantId);
  let interrupted = 0;

  const records = log.records.map((record) => {
    if (record.status !== "sending") return record;
    interrupted += 1;
    return {
      ...record,
      status: "uncertain" as const,
      message: UNCERTAIN_MESSAGE,
    };
  });

  if (interrupted === 0) return 0;
  writeLog(tenantId, { nextSeq: log.nextSeq, records });
  return interrupted;
}
