/**
 * Per-network publishing adapters.
 *
 * Two separate questions live here:
 *
 *  1. *Is this workspace signed in?* — answered from the partition's own cookie
 *     jar. Where a network keeps its session somewhere a cookie check cannot
 *     see (Bluesky and Mastodon hold tokens in local storage), the adapter says
 *     so instead of guessing.
 *
 *  2. *Can this build post here?* — only X, the primary network, drives its
 *     composer. Every other network reports honestly that this build cannot
 *     post for it; the operator posts from the workspace tab, where their own
 *     session already is. A silent success would be a lie about whether
 *     something reached an audience, and a fabricated one is worse than an
 *     error.
 */

import type { WebContents } from "electron";
import type { PublishOutcome } from "../session-bridge-server";
import { runInPage } from "./page";
import { unconfirmedOutcome } from "../idempotency";

export type SessionDetection =
  | { kind: "cookie"; names: string[] }
  | { kind: "unsupported"; reason: string };

export type SubmitContext = {
  contents: WebContents;
  body: string;
  /** Absolute epoch ms; the API server's bridge call times out at 20s. */
  deadline: number;
};

export type PlatformAdapter = {
  platform: string;
  label: string;
  origin: string;
  /** Where the automated publisher starts. */
  composeUrl: string;
  detection: SessionDetection;
  submit(context: SubmitContext): Promise<PublishOutcome>;
};

function notAutomated(label: string) {
  return async (): Promise<PublishOutcome> => ({
    kind: "rejected",
    detail:
      `This build cannot drive ${label}'s composer. Open the workspace tab and post from ` +
      `your signed-in session there; the draft stays approved until it is sent.`,
    status: 501,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * X's composer. Selectors are its stable `data-testid` hooks, kept together so
 * they can be repaired in one place when X moves them.
 */
const X_SELECTORS = {
  editor: '[data-testid="tweetTextarea_0"]',
  submit: '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]',
  toast: '[data-testid="toast"]',
  loginField: 'input[autocomplete="username"], [data-testid="loginButton"]',
};

type ProbeResult = "composer" | "login" | "waiting";

async function xSubmit(context: SubmitContext): Promise<PublishOutcome> {
  const { contents, body, deadline } = context;

  // 1. Wait for the composer, or for X to demand a login instead.
  let state: ProbeResult = "waiting";
  while (Date.now() < deadline) {
    state = await runInPage<ProbeResult>(
      contents,
      (selectors: typeof X_SELECTORS) => {
        if (document.querySelector(selectors.editor)) return "composer";
        if (document.querySelector(selectors.loginField)) return "login";
        if (/\/(i\/flow\/login|login)/.test(window.location.pathname)) return "login";
        return "waiting";
      },
      X_SELECTORS,
    );
    if (state !== "waiting") break;
    await sleep(250);
  }

  if (state === "login") {
    return {
      kind: "unauthenticated",
      detail: "X asked this workspace to sign in. Open the workspace tab and log in, then retry.",
    };
  }

  if (state !== "composer") {
    return {
      kind: "rejected",
      detail: "X's composer did not load in time; nothing was submitted.",
    };
  }

  // 2. Type the post. `insertText` goes through the same input path a keypress
  //    does, which is what X's editor listens to.
  const typed = await runInPage<{ ok: boolean; detail?: string }>(
    contents,
    (input: { selectors: typeof X_SELECTORS; text: string }) => {
      const editor = document.querySelector(input.selectors.editor) as HTMLElement | null;
      if (!editor) return { ok: false, detail: "The composer disappeared before the text was entered." };
      editor.focus();
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, input.text);
      const written = (editor.textContent ?? "").replace(/\u200b/g, "").trim();
      const expected = input.text.trim();
      if (written !== expected) {
        return {
          ok: false,
          detail: `The composer holds ${written.length} characters but the post is ${expected.length}.`,
        };
      }
      return { ok: true };
    },
    { selectors: X_SELECTORS, text: body },
  );

  if (!typed.ok) {
    return {
      kind: "rejected",
      detail: `Could not enter the post text on X. ${typed.detail ?? ""}`.trim(),
    };
  }

  // 3. Submit once the button is live.
  let clicked = false;
  while (Date.now() < deadline && !clicked) {
    clicked = await runInPage<boolean>(
      contents,
      (selectors: typeof X_SELECTORS) => {
        const button = document.querySelector(selectors.submit) as HTMLElement | null;
        if (!button) return false;
        if (button.getAttribute("aria-disabled") === "true") return false;
        button.click();
        return true;
      },
      X_SELECTORS,
    );
    if (!clicked) await sleep(200);
  }

  if (!clicked) {
    return {
      kind: "rejected",
      detail: "X never enabled its post button; the draft was not submitted.",
    };
  }

  // 4. Confirm. An emptied composer plus X's own toast is the signal; an error
  //    toast is a rejection. Anything else stays unconfirmed on purpose.
  while (Date.now() < deadline) {
    const confirmation = await runInPage<{
      state: "sent" | "error" | "waiting";
      detail?: string;
      postUrl?: string;
    }>(
      contents,
      (selectors: typeof X_SELECTORS) => {
        const toast = document.querySelector(selectors.toast) as HTMLElement | null;
        const toastText = (toast?.textContent ?? "").trim();
        const link = toast?.querySelector('a[href*="/status/"]') as HTMLAnchorElement | null;

        if (toastText && /(went wrong|could not|failed|error|try again)/i.test(toastText)) {
          return { state: "error" as const, detail: toastText };
        }
        if (link) {
          return { state: "sent" as const, postUrl: link.href, detail: toastText };
        }
        if (toastText && /(sent|posted)/i.test(toastText)) {
          return { state: "sent" as const, detail: toastText };
        }

        const editor = document.querySelector(selectors.editor);
        const emptied = !editor || (editor.textContent ?? "").trim() === "";
        const leftComposer = !/\/compose\//.test(window.location.pathname);
        if (emptied && leftComposer) return { state: "sent" as const };

        return { state: "waiting" as const };
      },
      X_SELECTORS,
    );

    if (confirmation.state === "error") {
      return { kind: "rejected", detail: `X rejected the post: ${confirmation.detail}` };
    }

    if (confirmation.state === "sent") {
      const postId = confirmation.postUrl?.match(/\/status\/(\d+)/)?.[1];
      return {
        kind: "published",
        postUrl: confirmation.postUrl,
        postId,
        detail: confirmation.detail ?? "X accepted the post.",
      };
    }

    await sleep(250);
  }

  return unconfirmedOutcome(
    "The post was submitted to X but no confirmation arrived before the deadline. " +
      "Check the account: this attempt will not be retried automatically, because a retry could double-post.",
  );
}

const ADAPTERS: PlatformAdapter[] = [
  {
    platform: "x",
    label: "X",
    origin: "https://x.com",
    composeUrl: "https://x.com/compose/post",
    detection: { kind: "cookie", names: ["auth_token"] },
    submit: xSubmit,
  },
  {
    platform: "instagram",
    label: "Instagram",
    origin: "https://www.instagram.com",
    composeUrl: "https://www.instagram.com/create/style/",
    detection: { kind: "cookie", names: ["sessionid"] },
    submit: notAutomated("Instagram"),
  },
  {
    platform: "facebook",
    label: "Facebook",
    origin: "https://www.facebook.com",
    composeUrl: "https://www.facebook.com/",
    detection: { kind: "cookie", names: ["c_user"] },
    submit: notAutomated("Facebook"),
  },
  {
    platform: "threads",
    label: "Threads",
    origin: "https://www.threads.net",
    composeUrl: "https://www.threads.net/",
    detection: { kind: "cookie", names: ["sessionid"] },
    submit: notAutomated("Threads"),
  },
  {
    platform: "linkedin",
    label: "LinkedIn",
    origin: "https://www.linkedin.com",
    composeUrl: "https://www.linkedin.com/feed/",
    detection: { kind: "cookie", names: ["li_at"] },
    submit: notAutomated("LinkedIn"),
  },
  {
    platform: "bluesky",
    label: "Bluesky",
    origin: "https://bsky.app",
    composeUrl: "https://bsky.app/",
    detection: {
      kind: "unsupported",
      reason: "Bluesky keeps its session in local storage, which a cookie check cannot see.",
    },
    submit: notAutomated("Bluesky"),
  },
  {
    platform: "mastodon",
    label: "Mastodon",
    origin: "https://mastodon.social",
    composeUrl: "https://mastodon.social/",
    detection: {
      kind: "unsupported",
      reason: "Mastodon sessions belong to whichever instance the workspace uses, not to one fixed origin.",
    },
    submit: notAutomated("Mastodon"),
  },
  {
    platform: "reddit",
    label: "Reddit",
    origin: "https://www.reddit.com",
    composeUrl: "https://www.reddit.com/submit",
    detection: { kind: "cookie", names: ["reddit_session"] },
    submit: notAutomated("Reddit"),
  },
  {
    platform: "tiktok",
    label: "TikTok",
    origin: "https://www.tiktok.com",
    composeUrl: "https://www.tiktok.com/upload",
    detection: { kind: "cookie", names: ["sessionid"] },
    submit: notAutomated("TikTok"),
  },
  {
    platform: "youtube",
    label: "YouTube",
    origin: "https://www.youtube.com",
    composeUrl: "https://studio.youtube.com/",
    detection: { kind: "cookie", names: ["SAPISID", "SID"] },
    submit: notAutomated("YouTube"),
  },
  {
    platform: "pinterest",
    label: "Pinterest",
    origin: "https://www.pinterest.com",
    composeUrl: "https://www.pinterest.com/pin-builder/",
    detection: { kind: "cookie", names: ["_pinterest_sess"] },
    submit: notAutomated("Pinterest"),
  },
  {
    platform: "tumblr",
    label: "Tumblr",
    origin: "https://www.tumblr.com",
    composeUrl: "https://www.tumblr.com/new/text",
    detection: { kind: "cookie", names: ["logged_in"] },
    submit: notAutomated("Tumblr"),
  },
];

export function adapterFor(platform: string): PlatformAdapter | null {
  return ADAPTERS.find((adapter) => adapter.platform === platform) ?? null;
}

export function knownPlatforms(): string[] {
  return ADAPTERS.map((adapter) => adapter.platform);
}
