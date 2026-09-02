/**
 * The publisher.
 *
 * A post leaves through the workspace's own signed-in Chromium session: the
 * shell opens the network's composer inside that workspace's BrowserContext,
 * under that workspace's UA profile, and drives it. There is no API token and
 * no headless impersonation anywhere in this path.
 *
 * The window is hidden because publishing runs unattended (an approved draft
 * can fire while the operator is on another workspace), not because anything is
 * being concealed: it is the same session, same cookies, same profile the
 * operator sees when they open the tab themselves.
 */

import { BrowserWindow } from "electron";
import type {
  PublishOutcome,
  PublishRequestInput,
  PublisherPort,
  SessionSnapshot,
  SignInInvitation,
} from "../session-bridge-server";
import type { IdempotencyLedger } from "../idempotency";
import { unconfirmedOutcome } from "../idempotency";
import type { WorkspaceDirectory, WorkspaceEntry } from "../workspace-directory";
import { applyEmulation, contextFor, detachEmulation, identityFrom } from "../workspace-contexts";
import { adapterFor, type PlatformAdapter } from "./adapters";
import { createLogger, errorFields } from "../logger";

const log = createLogger("publisher");

/**
 * `session-bridge.ts` in the API server abandons the call at 20s. Finishing
 * just inside that leaves the shell — not the caller — deciding what an
 * unconfirmed attempt means.
 */
const PUBLISH_BUDGET_MS = 17_000;

function identityForEntry(entry: WorkspaceEntry) {
  const profile = entry.profile;
  return identityFrom({
    workspaceId: entry.id,
    // A workspace with no UA profile still gets its own isolated context; it
    // simply runs under the shell's own Chromium identity.
    userAgent: profile?.userAgent ?? "",
    acceptLanguage: profile?.acceptLanguage ?? "en-US",
    timezone: profile?.timezone ?? "UTC",
    clientHints: profile?.clientHints ?? false,
  });
}

/**
 * How the publisher reaches the shell's tab strip.
 *
 * Kept as a port rather than a direct reference because the publisher is built
 * before the window exists, and because a signing-in operator should land in
 * the same tab they already use for that network.
 */
export type WorkspaceTabs = {
  openOrFocus(workspaceId: string, url: string): Promise<void>;
};

export function createPublisher(deps: {
  directory: WorkspaceDirectory;
  ledger: IdempotencyLedger;
  tabs: WorkspaceTabs;
}): PublisherPort {
  const { directory, ledger, tabs } = deps;

  async function signedIn(
    entry: WorkspaceEntry,
    adapter: PlatformAdapter,
  ): Promise<{ authenticated: boolean; detail: string }> {
    if (adapter.detection.kind === "unsupported") {
      return {
        authenticated: false,
        detail: `${adapter.label}: ${adapter.detection.reason} Open the workspace tab to check the session.`,
      };
    }

    const context = contextFor(identityForEntry(entry));
    const cookies = await context.cookies.get({ url: adapter.origin });
    const names = new Set(cookies.map((cookie) => cookie.name));
    const found = adapter.detection.names.filter((name) => names.has(name));

    if (found.length === 0) {
      return {
        authenticated: false,
        detail: `No ${adapter.label} session in this workspace's cookie jar. Open the workspace tab and sign in.`,
      };
    }

    return {
      authenticated: true,
      detail: `Signed in to ${adapter.label} in this workspace's own cookie jar.`,
    };
  }

  async function sessionStatus(
    workspaceId: string,
    platform?: string,
  ): Promise<SessionSnapshot> {
    const entry = await directory.resolve(workspaceId);
    if (!entry) {
      return {
        authenticated: false,
        detail: `The shell does not know a workspace called "${workspaceId}".`,
      };
    }

    // A workspace has a primary network, but one identity can hold accounts on
    // several. Each network is read on its own: a session on one is no
    // evidence at all about another.
    const wanted = platform ?? entry.platform;
    const adapter = adapterFor(wanted);
    if (!adapter) {
      return {
        authenticated: false,
        detail: `No adapter for ${wanted}; this shell cannot read that network's session.`,
      };
    }

    try {
      const result = await signedIn(entry, adapter);
      return {
        authenticated: result.authenticated,
        // The configured handle is only reported once a session actually
        // exists, and it is still the workspace's *configured* account rather
        // than a verified one — so it is never presented on its own.
        accountHandle: result.authenticated ? (entry.accountHandle ?? undefined) : undefined,
        detail: result.detail,
      };
    } catch (error) {
      log.error("Session check failed", { workspaceId, ...errorFields(error) });
      return {
        authenticated: false,
        detail: `Could not read this workspace's session: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  async function attempt(
    input: PublishRequestInput,
    entry: WorkspaceEntry,
    adapter: PlatformAdapter,
  ): Promise<PublishOutcome> {
    const identity = identityForEntry(entry);
    const context = contextFor(identity);

    const window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        session: context,
        // No preload: a network page must never see window.uaShell.
        preload: undefined,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        // An invisible window is still doing real work; Chromium must not
        // throttle its timers mid-post.
        backgroundThrottling: false,
      },
    });

    const deadline = Date.now() + PUBLISH_BUDGET_MS;

    try {
      await applyEmulation(window.webContents, identity);
      await window.loadURL(adapter.composeUrl);
      return await adapter.submit({ contents: window.webContents, body: input.body, deadline });
    } catch (error) {
      log.error("Publish attempt threw", {
        workspaceId: input.workspaceId,
        draftId: input.draftId,
        ...errorFields(error),
      });
      // The composer may or may not have accepted the post before this threw,
      // so this attempt is not retried automatically.
      return unconfirmedOutcome(
        `The publish attempt failed part-way: ${
          error instanceof Error ? error.message : String(error)
        }. Check the account before approving a resend.`,
      );
    } finally {
      detachEmulation(window.webContents);
      if (!window.isDestroyed()) window.destroy();
    }
  }

  /**
   * Live sign-in.
   *
   * Every account this app can post from is signed in here, by hand, in the
   * network's own page — inside the workspace's isolated jar and behind its UA
   * profile. That is the whole authentication story: no password is typed into
   * this app, no OAuth token is minted for a server to hold, and nothing is
   * stored anywhere but the session Chromium keeps for that workspace.
   *
   * Consequences worth stating plainly, because they are load-bearing:
   *
   *  - It happens in the workspace's own tab, in front of the operator.
   *    Publishing uses a hidden window because no human is there; a sign-in
   *    exists precisely so a human can act, and it belongs on the tab strip
   *    beside the network it signs into.
   *  - No preload runs in it, so the login page cannot see this app.
   *  - The shell never reads, fills, or intercepts the form. It has no reason
   *    to know the password, and code that could learn it is code that could
   *    leak it.
   *  - Success is not declared here. It is read back from the cookie jar by
   *    `sessionStatus`, so a closed window never turns into a false badge.
   */
  async function beginSignIn(
    workspaceId: string,
    platform?: string,
  ): Promise<SignInInvitation> {
    const entry = await directory.resolve(workspaceId);
    if (!entry) {
      return {
        opened: false,
        alreadySignedIn: false,
        detail: `The shell does not know a workspace called "${workspaceId}".`,
      };
    }

    // Signing in to a second network inside the same workspace is a normal
    // thing to want: the identity is the workspace, and the accounts hang off
    // it. The tab is the workspace's either way, so the session stays isolated.
    const wanted = platform ?? entry.platform;
    const adapter = adapterFor(wanted);
    if (!adapter) {
      return {
        opened: false,
        alreadySignedIn: false,
        detail: `No adapter for ${wanted}; this shell does not know where that network's sign-in lives.`,
      };
    }

    // Cookie-detectable networks can answer this without opening anything.
    if (adapter.detection.kind === "cookie") {
      const existing = await signedIn(entry, adapter);
      if (existing.authenticated) {
        return {
          opened: false,
          alreadySignedIn: true,
          detail: `This workspace is already signed in to ${adapter.label}.`,
        };
      }
    }

    try {
      // The tab carries this workspace's session and UA profile because it is
      // opened under the same identity every other view of this workspace uses.
      await tabs.openOrFocus(workspaceId, adapter.signInUrl);
    } catch (error) {
      log.error("Sign-in tab failed to open", { workspaceId, ...errorFields(error) });
      return {
        opened: false,
        alreadySignedIn: false,
        detail: `Could not open ${adapter.label}'s sign-in page: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    log.info("Opened a live sign-in tab", { workspaceId, platform: wanted });

    return {
      opened: true,
      alreadySignedIn: false,
      detail:
        `Sign in to ${adapter.label} in this workspace's tab. It runs in the workspace's own session ` +
        `and UA profile, so the account stays separate from every other workspace.`,
    };
  }

  async function publish(input: PublishRequestInput): Promise<PublishOutcome> {
    return ledger.run(
      input.idempotencyKey,
      { draftId: input.draftId, platform: input.platform },
      async () => {
        const entry = await directory.resolve(input.workspaceId);
        if (!entry) {
          return {
            kind: "rejected" as const,
            detail: `The shell does not know a workspace called "${input.workspaceId}".`,
            status: 404,
          };
        }

        const adapter = adapterFor(input.platform);
        if (!adapter) {
          return {
            kind: "rejected" as const,
            detail: `No publisher adapter for ${input.platform}.`,
            status: 501,
          };
        }

        const session = await signedIn(entry, adapter);
        if (!session.authenticated) {
          return { kind: "unauthenticated" as const, detail: session.detail };
        }

        log.info("Publishing through the workspace session", {
          workspaceId: input.workspaceId,
          draftId: input.draftId,
          platform: input.platform,
        });

        return attempt(input, entry, adapter);
      },
    );
  }

  return { sessionStatus, publish, beginSignIn };
}
