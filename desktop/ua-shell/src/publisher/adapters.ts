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
 *  2. *Can this build post here?* — the text networks are driven through the
 *     shared composer flow in `compose-driver.ts`. The ones that are refused
 *     are refused for a reason no selector can fix: a network that cannot
 *     accept a text-only post, or one that needs a target and a title a draft
 *     does not carry. Each says which, because "not supported" tells the
 *     operator nothing about whether waiting for a later build would help.
 *
 * A silent success would be a lie about whether something reached an audience,
 * and a fabricated one is worse than an error. No adapter may report
 * `published` on anything but the network's own confirmation.
 *
 * The selectors below belong to other people's products and will drift. Each
 * driven network needs one real post from a real account before it is trusted;
 * a drifted selector surfaces as a loud failure on that step, not as a quiet
 * non-post.
 */

import type { WebContents } from "electron";
import type { PublishOutcome } from "../session-bridge-server";
import type { IdentityConfig } from "./identity";
import { composerPage, runComposeFlow, type ComposerConfig } from "./compose-driver";

export type SessionDetection =
  | { kind: "cookie"; names: string[] }
  | { kind: "unsupported"; reason: string };

export type SubmitContext = {
  contents: WebContents;
  body: string;
  /**
   * Absolute paths to the approved attachments, in posting order. Already
   * checked against the approval's hashes by the caller — an adapter uploads
   * them, it does not decide whether they are allowed.
   */
  media: string[];
  /** Absolute epoch ms; the API server's bridge call times out at 20s. */
  deadline: number;
};

export type PlatformAdapter = {
  platform: string;
  label: string;
  origin: string;
  /** Where the automated publisher starts. */
  composeUrl: string;
  /**
   * Where a live sign-in starts. The operator types their credentials into
   * the network's own page inside this workspace's session; nothing about
   * that page is read, filled, or stored by the shell.
   */
  signInUrl: string;
  detection: SessionDetection;
  /**
   * How to find out *which* account is signed in.
   *
   * Absent means this shell cannot tell, and the operator is told that rather
   * than shown a stored label. Every selector here is product knowledge and
   * unverified, so a miss must read as unknown — never as the wrong name.
   */
  identity?: IdentityConfig;
  submit(context: SubmitContext): Promise<PublishOutcome>;
};

/**
 * A network this build will not post to, and the reason it will not.
 *
 * The reason is the useful part. "Requires media" means no future selector fix
 * changes anything until drafts can carry an image; "needs a community and a
 * title" names a gap in the draft model. Both are different from "the composer
 * moved", and an operator deciding whether to wait or to post by hand needs to
 * know which they have.
 */
function cannotPost(label: string, reason: string) {
  return async (_context: SubmitContext): Promise<PublishOutcome> => ({
    kind: "rejected",
    detail:
      `${label}: ${reason} Open the workspace tab and post from your signed-in session there; ` +
      `the draft stays approved until it is sent.`,
    status: 501,
  });
}

/** Wires a composer config to the shared flow. */
function driven(label: string, config: ComposerConfig) {
  return async (context: SubmitContext): Promise<PublishOutcome> =>
    runComposeFlow(composerPage(context.contents, config), {
      label,
      body: context.body,
      media: context.media,
      canAttach: config.fileInput !== undefined,
      reportsMediaReady: config.mediaAttached !== undefined,
      mediaRequired: config.mediaRequired === true,
      mediaFirst: config.mediaFirst === true,
      afterAttach: config.afterAttach,
      deadline: context.deadline,
      allowHotkey: config.submitHotkey === true,
      hasOpener: config.opener !== undefined,
    });
}

/**
 * Composer configs, one per driven network.
 *
 * Each selector list is deliberately more than one option: products ship a new
 * class name far more often than they change what a control *is*, so an
 * `aria-label` or a `data-testid` alongside the obvious selector buys real
 * resilience for no complexity.
 */
const COMPOSERS: Record<string, ComposerConfig> = {
  /**
   * X, on the shared flow.
   *
   * X used to have its own `xSubmit`, written before `compose-driver.ts` grew
   * the honesty rules the other networks now get for free. The cost of that
   * fork was measurable rather than theoretical: the shared driver learned to
   * treat "the composer vanished because the page bounced to a login" as an
   * unknown outcome, and X — never having been migrated — went on reporting it
   * as a successful post. Its own success test was "the editor is gone and we
   * are no longer on /compose/", and a login page satisfies both.
   *
   * Every signal below is the one `xSubmit` used, expressed in the schema, so
   * behaviour on the paths that already worked is unchanged. Two details are
   * load-bearing and easy to get wrong:
   *
   *  - `postLink` is scoped INSIDE the toast. `xSubmit` read the status link as
   *    `toast.querySelector(...)`; the driver's lookup is document-wide, and an
   *    unscoped `a[href*="/status/"]` would match any post in the timeline
   *    behind the composer — every attempt would "succeed" instantly.
   *  - `login.pathPattern` is deliberately unanchored, matching the original
   *    `/\/(i\/flow\/login|login)/` test against the pathname rather than
   *    anchoring it to the start.
   */
  x: {
    editor: '[data-testid="tweetTextarea_0"]',
    editorKind: "contenteditable",
    submit: '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]',
    fileInput: '[data-testid="fileInput"], input[type="file"][accept*="image"]',
    // Present only once the attachment has actually landed.
    mediaAttached:
      '[data-testid="attachments"] [data-testid="removeMedia"], [data-testid="attachments"] img',
    login: {
      selectors: 'input[autocomplete="username"], [data-testid="loginButton"]',
      pathPattern: "/(i/flow/login|login)",
    },
    confirmation: {
      toast: '[data-testid="toast"]',
      postLink: '[data-testid="toast"] a[href*="/status/"]',
      postUrlPattern: "/status/(\\d+)",
      successText: "sent|posted",
      errorText: "went wrong|could not|failed|error|try again",
      stillComposingPath: "/compose/",
    },
  },
  linkedin: {
    // `shareActive` opens the share box straight away rather than making the
    // driver hunt for the "Start a post" button on the feed.
    editor: '.ql-editor[contenteditable="true"], div[role="textbox"][contenteditable="true"]',
    editorKind: "contenteditable",
    submit:
      'button.share-actions__primary-action, button[aria-label="Post"], div[role="dialog"] button.artdeco-button--primary',
    fileInput: 'input[type="file"][accept*="image"], .share-box input[type="file"]',
    mediaAttached: '.share-images, .image-selector, [data-test-id="media-preview"]',
    login: { selectors: 'input[name="session_key"]', pathPattern: "^/(login|uas/login|checkpoint)" },
    confirmation: {
      toast: '[data-test-artdeco-toast-item], .artdeco-toast-item__message',
      successText: "post (was )?(successfully )?(shared|posted)|your post is live",
      errorText: "went wrong|couldn't|could not|failed|try again",
      stillComposingPath: "shareActive",
    },
  },
  facebook: {
    opener:
      'div[role="button"][aria-label*="mind"], div[role="button"][aria-label*="Mind"], [data-pagelet="FeedComposer"] div[role="button"]',
    editor: 'div[role="dialog"] div[contenteditable="true"][role="textbox"]',
    editorKind: "contenteditable",
    submit:
      'div[role="dialog"] div[role="button"][aria-label="Post"], div[role="dialog"] button[type="submit"]',
    fileInput: 'div[role="dialog"] input[type="file"]',
    mediaAttached: 'div[role="dialog"] img[src^="blob:"], div[role="dialog"] [aria-label*="Remove"]',
    login: { selectors: 'input[name="pass"]', pathPattern: "^/(login|checkpoint)" },
    confirmation: {
      errorText: "went wrong|couldn't|could not|failed|try again",
    },
  },
  threads: {
    opener:
      'div[role="button"][aria-label*="Create"], div[role="button"][aria-label*="new thread"], svg[aria-label="Create"]',
    editor: 'div[contenteditable="true"][role="textbox"], div[data-lexical-editor="true"]',
    editorKind: "contenteditable",
    submit: 'div[role="button"][aria-label="Post"], div[role="dialog"] div[role="button"]:not([aria-disabled="true"])',
    fileInput: 'input[type="file"][accept*="image"]',
    mediaAttached: 'img[src^="blob:"], [aria-label*="Remove"]',
    // Threads posts on Ctrl/Cmd+Enter, which is steadier than its button.
    submitHotkey: true,
    login: { selectors: 'input[name="username"]', pathPattern: "^/login" },
    confirmation: {
      successText: "posted|thread posted",
      errorText: "went wrong|couldn't|could not|failed|try again",
    },
  },
  bluesky: {
    editor: '[data-testid="composerTextInput"], div[contenteditable="true"][role="textbox"]',
    editorKind: "contenteditable",
    submit: '[data-testid="composerPublishBtn"]',
    fileInput: 'input[type="file"][accept*="image"]',
    mediaAttached: '[data-testid="images"] img, img[src^="blob:"]',
    submitHotkey: true,
    login: { selectors: '[data-testid="loginUsernameInput"], [data-testid="signInButton"]' },
    confirmation: {
      successText: "posted|your post was published",
      errorText: "went wrong|couldn't|could not|failed|try again",
      stillComposingPath: "intent/compose",
    },
  },
  mastodon: {
    editor: 'textarea.autosuggest-textarea__textarea, textarea#compose-textarea, .compose-form textarea',
    editorKind: "textarea",
    submit: 'button.compose-form__submit, .compose-form button[type="submit"]',
    fileInput: '.compose-form input[type="file"]',
    mediaAttached: '.compose-form__upload-thumbnail, .compose-form .media-gallery',
    submitHotkey: true,
    login: { pathPattern: "^/auth/sign_in" },
    confirmation: {
      errorText: "went wrong|couldn't|could not|failed|try again",
    },
  },
  /**
   * Instagram is upload-first and multi-screen: choose a file, crop, filter,
   * then caption, then share. There is no caption field at all until the image
   * is in, which is why the flow waits for the upload control rather than an
   * editor.
   *
   * The two "Next" buttons carry the same accessible name, so each is taken in
   * order and each waits for the screen it should have produced — otherwise a
   * double-click on the crop step would look like progress and land the flow on
   * the wrong screen with no way to tell.
   */
  instagram: {
    opener:
      'svg[aria-label="New post"], a[href="#"][role="link"] svg[aria-label="New post"], div[role="button"]:has(svg[aria-label="New post"])',
    fileInput: 'input[type="file"][accept*="image"]',
    mediaAttached: 'div[role="dialog"] img[src^="blob:"], div[role="dialog"] canvas',
    mediaRequired: true,
    mediaFirst: true,
    afterAttach: [
      {
        click: 'div[role="dialog"] div[role="button"]:not([aria-disabled="true"])',
        waitFor: 'div[role="dialog"]',
        label: "crop",
      },
      {
        click: 'div[role="dialog"] div[role="button"]:not([aria-disabled="true"])',
        waitFor: 'div[role="dialog"] textarea, div[role="dialog"] div[contenteditable="true"]',
        label: "filter",
      },
    ],
    editor:
      'div[role="dialog"] textarea[aria-label*="aption"], div[role="dialog"] div[contenteditable="true"][role="textbox"]',
    editorKind: "contenteditable",
    submit: 'div[role="dialog"] div[role="button"]:not([aria-disabled="true"])',
    login: { selectors: 'input[name="password"]', pathPattern: "^/accounts/login" },
    confirmation: {
      successText: "post shared|your post has been shared",
      errorText: "went wrong|couldn't|could not|failed|try again",
    },
  },
  /**
   * Pinterest's pin builder is upload-first but single-screen: once the image
   * is in, the title, description and board controls are all on the page.
   *
   * The draft's body goes in the description, which is the caption equivalent;
   * the title is left empty, which Pinterest accepts.
   *
   * BOARD SELECTION IS NOT MODELLED. A pin belongs to a board, and this build
   * has no way to know which one — so it publishes to whatever board Pinterest
   * already has selected. When none is selected, the publish button never
   * enables and the attempt fails loudly rather than guessing. That is the
   * honest behaviour, but it is a real limit: check which board is selected
   * before trusting a scheduled pin.
   */
  pinterest: {
    fileInput: 'input[type="file"][accept*="image"], [data-test-id="media-upload-input"] input[type="file"]',
    mediaAttached: '[data-test-id="pin-draft-image"] img, img[src^="blob:"]',
    mediaRequired: true,
    mediaFirst: true,
    editor:
      '[data-test-id="pin-draft-description"] div[contenteditable="true"], div[contenteditable="true"][aria-label*="escription"]',
    editorKind: "contenteditable",
    submit: '[data-test-id="board-dropdown-save-button"] button, button[type="submit"]',
    login: { pathPattern: "^/login" },
    confirmation: {
      postLink: 'a[href*="/pin/"]',
      postUrlPattern: "/pin/(\\d+)",
      successText: "your pin (was|has been) (published|saved)|pin created",
      errorText: "went wrong|couldn't|could not|failed|try again",
      stillComposingPath: "pin-builder",
    },
  },
  tumblr: {
    editor: 'div[contenteditable="true"][role="textbox"], .post-form--content [contenteditable="true"]',
    editorKind: "contenteditable",
    submit: 'button[aria-label="Post"], [data-testid="postFormButton"], .post-form--footer button.blue',
    fileInput: 'input[type="file"][accept*="image"]',
    mediaAttached: 'img[src^="blob:"], .post-form--content img',
    login: { pathPattern: "^/login" },
    confirmation: {
      errorText: "went wrong|couldn't|could not|failed|try again",
      stillComposingPath: "^/new/",
    },
  },
};

/**
 * The two networks that want a video specifically.
 *
 * Instagram and Pinterest were in this group until attachments shipped; both
 * are driven now. These two are not, and the reason is narrower than it was: a
 * post here needs a *video*, and a draft carries images and video files but
 * nothing that makes an encode, a thumbnail, or YouTube Studio's own multi-page
 * upload wizard into something the composer flow can walk.
 */
const MEDIA_REQUIRED =
  "a post here needs a video, and this build drives image composers rather than a video upload wizard. Attaching an MP4 to a draft does not change that yet.";

const ADAPTERS: PlatformAdapter[] = [
  {
    platform: "x",
    label: "X",
    origin: "https://x.com",
    signInUrl: "https://x.com/i/flow/login",
    composeUrl: "https://x.com/compose/post",
    detection: { kind: "cookie", names: ["auth_token"] },
    identity: {
      // `twid` holds `u%3D<numeric id>` — proof of which account, without a name.
      idCookie: { name: "twid", pattern: "u=(\\d+)" },
      // The account switcher in the left nav names the signed-in account; its
      // aria-label carries the handle even when the button collapses to an
      // avatar on a narrow window.
      handle: {
        selectors: [
          '[data-testid="SideNav_AccountSwitcher_Button"]',
          '[data-testid="UserAvatar-Container-unknown"]',
        ],
      },
    },
    submit: driven("X", COMPOSERS.x!),
  },
  {
    platform: "instagram",
    label: "Instagram",
    origin: "https://www.instagram.com",
    signInUrl: "https://www.instagram.com/accounts/login/",
    composeUrl: "https://www.instagram.com/",
    detection: { kind: "cookie", names: ["sessionid"] },
    identity: {
      idCookie: { name: "ds_user_id" },
      // Instagram shows no `@` anywhere in its chrome; the profile link in the
      // nav is `/<username>/`, and `pageText` includes href for this reason.
      handle: {
        selectors: ['nav a[href^="/"][role="link"]:has(img)', 'a[href^="/"][tabindex="0"]:has(img)'],
        pattern: "/([A-Za-z0-9._]{1,30})/",
      },
    },
    submit: driven("Instagram", COMPOSERS.instagram!),
  },
  {
    platform: "facebook",
    label: "Facebook",
    origin: "https://www.facebook.com",
    signInUrl: "https://www.facebook.com/login",
    composeUrl: "https://www.facebook.com/",
    detection: { kind: "cookie", names: ["c_user"] },
    // `c_user` is the account id. Facebook does not show a handle in its
    // chrome and profile links are numeric, so the id is the whole answer.
    identity: { idCookie: { name: "c_user" } },
    submit: driven("Facebook", COMPOSERS.facebook!),
  },
  {
    platform: "threads",
    label: "Threads",
    origin: "https://www.threads.net",
    signInUrl: "https://www.threads.net/login",
    composeUrl: "https://www.threads.net/",
    detection: { kind: "cookie", names: ["sessionid"] },
    identity: {
      idCookie: { name: "ds_user_id" },
      handle: {
        selectors: ['a[href^="/@"]'],
        pattern: "/@([A-Za-z0-9._]{1,30})",
      },
    },
    submit: driven("Threads", COMPOSERS.threads!),
  },
  {
    platform: "linkedin",
    label: "LinkedIn",
    origin: "https://www.linkedin.com",
    signInUrl: "https://www.linkedin.com/login",
    composeUrl: "https://www.linkedin.com/feed/?shareActive=true",
    detection: { kind: "cookie", names: ["li_at"] },
    submit: driven("LinkedIn", COMPOSERS.linkedin!),
  },
  {
    platform: "bluesky",
    label: "Bluesky",
    origin: "https://bsky.app",
    signInUrl: "https://bsky.app/",
    composeUrl: "https://bsky.app/intent/compose",
    detection: {
      kind: "unsupported",
      reason: "Bluesky keeps its session in local storage, which a cookie check cannot see.",
    },
    identity: {
      // No cookie to read, but the signed-in profile link carries the handle,
      // which is also the one thing a cookie check could never tell us here.
      handle: {
        selectors: ['[data-testid="profileCardHeaderDisplayName"]', 'a[href^="/profile/"]'],
        pattern: "/profile/([A-Za-z0-9._-]{1,64})",
      },
    },
    submit: driven("Bluesky", COMPOSERS.bluesky!),
  },
  {
    platform: "mastodon",
    label: "Mastodon",
    origin: "https://mastodon.social",
    signInUrl: "https://mastodon.social/auth/sign_in",
    composeUrl: "https://mastodon.social/home",
    detection: {
      kind: "unsupported",
      reason: "Mastodon sessions belong to whichever instance the workspace uses, not to one fixed origin.",
    },
    identity: {
      // Mastodon prints the full `@user@instance` in its own navigation bar.
      handle: {
        selectors: [".navigation-bar__profile-account", ".account__header__tabs__name small"],
      },
    },
    submit: driven("Mastodon", COMPOSERS.mastodon!),
  },
  {
    platform: "reddit",
    label: "Reddit",
    origin: "https://www.reddit.com",
    signInUrl: "https://www.reddit.com/login",
    composeUrl: "https://www.reddit.com/submit",
    detection: { kind: "cookie", names: ["reddit_session"] },
    submit: cannotPost(
      "Reddit",
      "a submission needs a community and a title, and a draft carries neither yet. Posting one into the wrong subreddit is not a mistake worth automating.",
    ),
  },
  {
    platform: "tiktok",
    label: "TikTok",
    origin: "https://www.tiktok.com",
    signInUrl: "https://www.tiktok.com/login",
    composeUrl: "https://www.tiktok.com/upload",
    detection: { kind: "cookie", names: ["sessionid"] },
    submit: cannotPost("TikTok", MEDIA_REQUIRED),
  },
  {
    platform: "youtube",
    label: "YouTube",
    origin: "https://www.youtube.com",
    signInUrl: "https://accounts.google.com/ServiceLogin?service=youtube",
    composeUrl: "https://studio.youtube.com/",
    detection: { kind: "cookie", names: ["SAPISID", "SID"] },
    submit: cannotPost("YouTube", MEDIA_REQUIRED),
  },
  {
    platform: "pinterest",
    label: "Pinterest",
    origin: "https://www.pinterest.com",
    signInUrl: "https://www.pinterest.com/login/",
    composeUrl: "https://www.pinterest.com/pin-builder/",
    detection: { kind: "cookie", names: ["_pinterest_sess"] },
    submit: driven("Pinterest", COMPOSERS.pinterest!),
  },
  {
    platform: "tumblr",
    label: "Tumblr",
    origin: "https://www.tumblr.com",
    signInUrl: "https://www.tumblr.com/login",
    composeUrl: "https://www.tumblr.com/new/text",
    detection: { kind: "cookie", names: ["logged_in"] },
    // `logged_in=1` says a session exists and nothing about whose it is.
    identity: {
      handle: {
        selectors: ['[data-testid="controlMenuUserAvatar"]', 'a[href^="https://www.tumblr.com/blog/"]'],
        pattern: "/blog/([A-Za-z0-9._-]{1,64})",
      },
    },
    submit: driven("Tumblr", COMPOSERS.tumblr!),
  },
];

export function adapterFor(platform: string): PlatformAdapter | null {
  return ADAPTERS.find((adapter) => adapter.platform === platform) ?? null;
}

/**
 * The composer config a driven network uses, for tests and diagnostics.
 *
 * Exported so the config can be asserted without a display or a session: the
 * selectors stay unverifiable, but what the config *claims* — which toast text
 * means sent, where the post link is scoped, which paths are a login — is
 * checkable, and X is the one adapter whose behaviour must not drift.
 */
export function composerConfigFor(platform: string): ComposerConfig | null {
  return COMPOSERS[platform] ?? null;
}

export function knownPlatforms(): string[] {
  return ADAPTERS.map((adapter) => adapter.platform);
}
