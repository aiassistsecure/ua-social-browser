/**
 * Session bridge.
 *
 * Posting always travels through the user's own authenticated browser session
 * inside the native shell — never through a server-side API token and never
 * through a headless impersonation of the user. This module is the thin,
 * typed boundary between the workspace API server and the native shell's
 * privileged IPC endpoint.
 *
 * The native shell exposes the endpoint on loopback and hands its address to
 * the API server through UA_SESSION_BRIDGE_URL. When that variable is absent
 * (for example, when the web development surface runs on its own), publishing
 * reports "unavailable" instead of pretending to post.
 */

export type BridgeStatus = {
  workspaceId: string;
  bridgeAvailable: boolean;
  authenticated: boolean;
  accountHandle?: string;
  detail: string;
};

export type BridgePublishInput = {
  workspaceId: string;
  draftId: string;
  platform: string;
  body: string;
  idempotencyKey: string;
};

export type BridgePublishOutcome =
  | { kind: "published"; postUrl?: string; postId?: string }
  | { kind: "unauthenticated"; detail: string }
  | { kind: "rejected"; detail: string }
  | { kind: "unavailable"; detail: string };

const REQUEST_TIMEOUT_MS = 20_000;

function bridgeUrl(): string | null {
  const raw = process.env.UA_SESSION_BRIDGE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

export function isBridgeConfigured(): boolean {
  return bridgeUrl() !== null;
}

async function callBridge(
  path: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const base = bridgeUrl();
  if (!base) {
    throw new Error("Session bridge is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const text = await response.text();
    const payload: unknown = text ? JSON.parse(text) : null;
    return { ok: response.ok, status: response.status, payload };
  } finally {
    clearTimeout(timer);
  }
}

export async function readSessionStatus(
  workspaceId: string,
): Promise<BridgeStatus> {
  if (!isBridgeConfigured()) {
    return {
      workspaceId,
      bridgeAvailable: false,
      authenticated: false,
      detail:
        "No native session bridge attached. Posting is only possible from the desktop shell, where your own signed-in session lives.",
    };
  }

  try {
    const { ok, payload } = await callBridge(
      `/session/${encodeURIComponent(workspaceId)}`,
      { method: "GET" },
    );

    if (!ok) {
      return {
        workspaceId,
        bridgeAvailable: true,
        authenticated: false,
        detail: "The shell could not report this workspace's session state.",
      };
    }

    const data = (payload ?? {}) as {
      authenticated?: boolean;
      accountHandle?: string;
      detail?: string;
    };

    return {
      workspaceId,
      bridgeAvailable: true,
      authenticated: Boolean(data.authenticated),
      accountHandle: data.accountHandle,
      detail:
        data.detail ??
        (data.authenticated
          ? "Workspace session is signed in and ready to post."
          : "Sign in to the platform inside this workspace before publishing."),
    };
  } catch (error) {
    return {
      workspaceId,
      bridgeAvailable: false,
      authenticated: false,
      detail:
        error instanceof Error
          ? `Session bridge unreachable: ${error.message}`
          : "Session bridge unreachable.",
    };
  }
}

export async function publishThroughSession(
  input: BridgePublishInput,
): Promise<BridgePublishOutcome> {
  if (!isBridgeConfigured()) {
    return {
      kind: "unavailable",
      detail:
        "Publishing requires the desktop shell. The web surface has no access to your authenticated platform session.",
    };
  }

  try {
    const { ok, status, payload } = await callBridge("/publish", {
      method: "POST",
      body: JSON.stringify(input),
    });

    const data = (payload ?? {}) as {
      postUrl?: string;
      postId?: string;
      detail?: string;
      error?: string;
    };

    if (ok) {
      return { kind: "published", postUrl: data.postUrl, postId: data.postId };
    }

    if (status === 401 || status === 403) {
      return {
        kind: "unauthenticated",
        detail:
          data.detail ??
          "The workspace session is not signed in to this platform.",
      };
    }

    return {
      kind: "rejected",
      detail:
        data.detail ?? data.error ?? `The platform rejected the post (${status}).`,
    };
  } catch (error) {
    return {
      kind: "unavailable",
      detail:
        error instanceof Error
          ? `Session bridge unreachable: ${error.message}`
          : "Session bridge unreachable.",
    };
  }
}
