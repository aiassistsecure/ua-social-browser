/**
 * A shared composer driver.
 *
 * Every text network works the same way from the outside: wait for a composer,
 * put the approved text in it, submit once, and then decide whether the post
 * actually went out. Only the selectors differ. Writing that flow once means
 * the part that matters — deciding what counts as "sent" — is written once and
 * tested once, instead of eleven times with eleven different bugs.
 *
 * The rule the flow exists to enforce: **an outcome is only `published` when
 * the network said so.** Anything else is a rejection or, when the post may
 * have gone out but nothing confirmed it, an unconfirmed result that is never
 * retried automatically. A driver that guessed would eventually double-post or
 * claim an audience that never saw anything.
 *
 * Selectors belong to other people's products and will drift. When one does,
 * the flow reports which step failed rather than falling through to a cheerful
 * result — repair the config, not the reasoning.
 */

import type { WebContents } from "electron";
import type { PublishOutcome } from "../session-bridge-server";
import { unconfirmedOutcome } from "../idempotency";
import { runInPage } from "./page";
import { setFileInput } from "./upload";

export type ProbeState = "composer" | "login" | "waiting";

export type ConfirmState =
  | { state: "sent"; postUrl?: string; postId?: string; detail?: string }
  | { state: "error"; detail: string }
  | { state: "login" }
  | { state: "waiting" };

export type ComposerConfig = {
  /**
   * Clicked when the composer is not already on screen. Facebook and Threads
   * post from a dialog that only exists after something is clicked.
   */
  opener?: string;
  editor: string;
  editorKind: "contenteditable" | "textarea";
  submit: string;
  /**
   * Send Ctrl/Cmd+Enter as real input when no submit button is clickable. Some
   * composers render their button in a way no stable selector reaches, but
   * every one of them honours the keyboard shortcut.
   */
  submitHotkey?: boolean;
  /**
   * The network's `<input type="file">`. Usually hidden behind a styled
   * button, so it is found structurally rather than by visibility.
   *
   * Absent means this composer has no upload control wired up yet, and a
   * draft carrying an attachment is refused rather than posted without it.
   */
  fileInput?: string;
  /**
   * Present once an attachment has finished attaching — a thumbnail, a
   * preview, a remove button. Submitting before this exists posts the text
   * without the picture, which is a different post from the approved one.
   */
  mediaAttached?: string;
  login: { selectors?: string; pathPattern?: string };
  confirmation: {
    toast?: string;
    /** An anchor to the post that was just created. The strongest signal. */
    postLink?: string;
    /** Regex source; capture group 1 is the post id. */
    postUrlPattern?: string;
    /** Regex sources, matched case-insensitively against the toast text. */
    successText?: string;
    errorText?: string;
    /** Regex source. While the URL still matches, the post has not left. */
    stillComposingPath?: string;
  };
};

/**
 * The four things the driver does to a page. Split out so the flow can be
 * tested against a fake page: the orchestration is what decides honesty, and
 * it should not need Electron or a network account to prove it behaves.
 */
export type ComposerPage = {
  probe(): Promise<ProbeState>;
  openComposer(): Promise<boolean>;
  enterText(text: string): Promise<{ ok: boolean; detail?: string }>;
  attachMedia(paths: string[]): Promise<{ ok: boolean; detail?: string }>;
  mediaReady(): Promise<boolean>;
  clickSubmit(): Promise<boolean>;
  pressSubmitHotkey(): Promise<void>;
  confirm(): Promise<ConfirmState>;
};

export type ComposeFlowOptions = {
  label: string;
  body: string;
  /** Absolute paths, already checked against the approval by the caller. */
  media?: string[];
  /** True when this composer declares a file input. */
  canAttach?: boolean;
  /** True when this composer can tell an attachment finished uploading. */
  reportsMediaReady?: boolean;
  /** Absolute epoch ms. The API server abandons the bridge call at 20s. */
  deadline: number;
  allowHotkey: boolean;
  hasOpener: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const POLL_MS = 250;

/** How much of the remaining budget the click-the-button phase may spend. */
const SUBMIT_PHASE_SHARE = 0.4;

export async function runComposeFlow(
  page: ComposerPage,
  options: ComposeFlowOptions,
): Promise<PublishOutcome> {
  const { label, body, deadline, allowHotkey, hasOpener } = options;
  const media = options.media ?? [];
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  // 1. Wait for the composer, opening it once if this network hides it behind
  //    a button. A login screen instead is a different answer, not a failure:
  //    the draft stays approved and the operator signs in.
  let opened = false;
  let state: ProbeState = "waiting";
  while (now() < deadline) {
    state = await page.probe();
    if (state !== "waiting") break;
    if (hasOpener && !opened) {
      opened = await page.openComposer();
    }
    await sleep(POLL_MS);
  }

  if (state === "login") {
    return {
      kind: "unauthenticated",
      detail: `${label} asked this workspace to sign in. Open the workspace tab and log in, then retry.`,
    };
  }

  if (state !== "composer") {
    return {
      kind: "rejected",
      detail: `${label}'s composer did not load in time; nothing was submitted.`,
    };
  }

  // 2. Enter the text, and read it back. A composer that holds something other
  //    than the approved text must not be submitted — the approval was for
  //    those exact words.
  const typed = await page.enterText(body);
  if (!typed.ok) {
    return {
      kind: "rejected",
      detail: `Could not enter the post text on ${label}. ${typed.detail ?? ""}`.trim(),
    };
  }

  // 2b. Attach the files, and wait for the network to finish taking them.
  //
  //     An upload that is still in flight when the button is pressed posts the
  //     words without the picture. That is not a smaller version of the
  //     approved post; it is a different one, and on a network that requires
  //     media it may not be a post at all.
  if (media.length > 0) {
    if (!options.canAttach) {
      return {
        kind: "rejected",
        detail: `This build cannot attach files on ${label} yet, and the post carries ${
          media.length === 1 ? "an attachment" : "attachments"
        }. Nothing was posted; post it from the workspace tab instead.`,
      };
    }

    const attached = await page.attachMedia(media);
    if (!attached.ok) {
      return {
        kind: "rejected",
        detail: `Could not attach the file on ${label}. ${attached.detail ?? ""}`.trim(),
      };
    }

    if (options.reportsMediaReady) {
      let ready = false;
      while (now() < deadline && !ready) {
        ready = await page.mediaReady();
        if (!ready) await sleep(POLL_MS);
      }
      if (!ready) {
        return {
          kind: "rejected",
          detail: `${label} never finished taking the attachment, so nothing was submitted.`,
        };
      }
    }
  }

  // 3. Submit once.
  //
  //    Where a keyboard shortcut is available, the hunt for a clickable button
  //    gets only part of the budget: spending all of it means the fallback
  //    fires with no time left to find out what it did, which turns every
  //    button drift into an unconfirmed post.
  const submitDeadline = allowHotkey
    ? Math.min(deadline, now() + Math.max(1_000, (deadline - now()) * SUBMIT_PHASE_SHARE))
    : deadline;

  let submitted = false;
  while (now() < submitDeadline && !submitted) {
    submitted = await page.clickSubmit();
    if (!submitted) await sleep(200);
  }

  if (!submitted) {
    if (!allowHotkey) {
      return {
        kind: "rejected",
        detail: `${label} never enabled its post button; the draft was not submitted.`,
      };
    }
    // A real key event, not a synthetic one, so the page cannot tell it from
    // the operator pressing the keys themselves.
    await page.pressSubmitHotkey();
  }

  // 4. Confirm. Silence is not success.
  while (now() < deadline) {
    const confirmation = await page.confirm();

    if (confirmation.state === "error") {
      return { kind: "rejected", detail: `${label} rejected the post: ${confirmation.detail}` };
    }

    if (confirmation.state === "login") {
      return unconfirmedOutcome(
        `${label} asked for a sign-in immediately after the post was submitted, so whether it went out is unknown. ` +
          `Check the account: this attempt will not be retried automatically, because a retry could double-post.`,
      );
    }

    if (confirmation.state === "sent") {
      return {
        kind: "published",
        postUrl: confirmation.postUrl,
        postId: confirmation.postId,
        detail: confirmation.detail ?? `${label} accepted the post.`,
      };
    }

    await sleep(POLL_MS);
  }

  return unconfirmedOutcome(
    `The post was submitted to ${label} but no confirmation arrived before the deadline. ` +
      `Check the account: this attempt will not be retried automatically, because a retry could double-post.`,
  );
}

/**
 * Binds a config to a real page.
 *
 * Every function below is serialized into the page, so it may only touch its
 * own arguments — the config travels with it.
 */
export function composerPage(contents: WebContents, config: ComposerConfig): ComposerPage {
  return {
    async probe() {
      return runInPage<ProbeState>(
        contents,
        (cfg: ComposerConfig) => {
          if (document.querySelector(cfg.editor)) return "composer";
          if (cfg.login.selectors && document.querySelector(cfg.login.selectors)) return "login";
          if (cfg.login.pathPattern && new RegExp(cfg.login.pathPattern).test(window.location.pathname)) {
            return "login";
          }
          return "waiting";
        },
        config,
      );
    },

    async openComposer() {
      return runInPage<boolean>(
        contents,
        (cfg: ComposerConfig) => {
          if (!cfg.opener) return false;
          const button = document.querySelector(cfg.opener) as HTMLElement | null;
          if (!button) return false;
          button.click();
          return true;
        },
        config,
      );
    },

    async enterText(text: string) {
      return runInPage<{ ok: boolean; detail?: string }>(
        contents,
        (input: { cfg: ComposerConfig; text: string }) => {
          const editor = document.querySelector(input.cfg.editor) as HTMLElement | null;
          if (!editor) {
            return { ok: false, detail: "The composer disappeared before the text was entered." };
          }

          const expected = input.text.trim();
          editor.focus();

          if (input.cfg.editorKind === "textarea") {
            // A React-controlled field ignores a plain value assignment, so go
            // through the native setter and announce it the way typing does.
            const field = editor as HTMLTextAreaElement | HTMLInputElement;
            const prototype =
              field instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
            if (setter) setter.call(field, input.text);
            else field.value = input.text;
            field.dispatchEvent(new Event("input", { bubbles: true }));
            field.dispatchEvent(new Event("change", { bubbles: true }));

            const written = (field.value ?? "").trim();
            if (written !== expected) {
              return {
                ok: false,
                detail: `The composer holds ${written.length} characters but the post is ${expected.length}.`,
              };
            }
            return { ok: true };
          }

          document.execCommand("selectAll", false);
          document.execCommand("insertText", false, input.text);
          const written = (editor.textContent ?? "").replace(/\u200b/g, "").trim();
          if (written !== expected) {
            return {
              ok: false,
              detail: `The composer holds ${written.length} characters but the post is ${expected.length}.`,
            };
          }
          return { ok: true };
        },
        { cfg: config, text },
      );
    },

    async attachMedia(paths: string[]) {
      if (!config.fileInput) {
        return { ok: false, detail: "No upload control is configured for this network." };
      }
      const result = await setFileInput(contents, config.fileInput, paths);
      return result.ok ? { ok: true } : { ok: false, detail: result.detail };
    },

    async mediaReady() {
      if (!config.mediaAttached) return true;
      return runInPage<boolean>(
        contents,
        (cfg: ComposerConfig) =>
          cfg.mediaAttached ? !!document.querySelector(cfg.mediaAttached) : true,
        config,
      );
    },

    async clickSubmit() {
      return runInPage<boolean>(
        contents,
        (cfg: ComposerConfig) => {
          const buttons = Array.from(
            document.querySelectorAll(cfg.submit),
          ) as HTMLElement[];
          for (const button of buttons) {
            if (button.getAttribute("aria-disabled") === "true") continue;
            if ((button as HTMLButtonElement).disabled) continue;
            if (button.offsetParent === null) continue;
            button.click();
            return true;
          }
          return false;
        },
        config,
      );
    },

    async pressSubmitHotkey() {
      const modifier = process.platform === "darwin" ? "meta" : "control";
      contents.sendInputEvent({ type: "keyDown", keyCode: "Enter", modifiers: [modifier] });
      contents.sendInputEvent({ type: "keyUp", keyCode: "Enter", modifiers: [modifier] });
    },

    async confirm() {
      return runInPage<ConfirmState>(
        contents,
        (cfg: ComposerConfig) => {
          const rules = cfg.confirmation;

          const toast = rules.toast
            ? (document.querySelector(rules.toast) as HTMLElement | null)
            : null;
          const toastText = (toast?.textContent ?? "").trim();

          if (rules.errorText && toastText && new RegExp(rules.errorText, "i").test(toastText)) {
            return { state: "error", detail: toastText };
          }

          const link = rules.postLink
            ? (document.querySelector(rules.postLink) as HTMLAnchorElement | null)
            : null;
          if (link?.href) {
            const id = rules.postUrlPattern
              ? (link.href.match(new RegExp(rules.postUrlPattern))?.[1] ?? undefined)
              : undefined;
            return {
              state: "sent",
              postUrl: link.href,
              postId: id,
              detail: toastText || undefined,
            };
          }

          if (rules.successText && toastText && new RegExp(rules.successText, "i").test(toastText)) {
            return { state: "sent", detail: toastText };
          }

          // A composer that vanished because the page bounced to a login says
          // nothing about whether the post went out — and must not be read as
          // an emptied composer.
          const wentToLogin =
            (!!cfg.login.selectors && !!document.querySelector(cfg.login.selectors)) ||
            (!!cfg.login.pathPattern &&
              new RegExp(cfg.login.pathPattern).test(window.location.pathname));
          if (wentToLogin) return { state: "login" };

          const editor = document.querySelector(cfg.editor) as
            | HTMLTextAreaElement
            | HTMLElement
            | null;
          const contents_ =
            editor === null
              ? ""
              : ((editor as HTMLTextAreaElement).value ?? editor.textContent ?? "");
          const emptied = editor === null || contents_.trim() === "";
          const stillComposing = rules.stillComposingPath
            ? new RegExp(rules.stillComposingPath).test(
                window.location.pathname + window.location.search,
              )
            : false;

          if (emptied && !stillComposing) return { state: "sent" };
          return { state: "waiting" };
        },
        config,
      );
    },
  };
}
