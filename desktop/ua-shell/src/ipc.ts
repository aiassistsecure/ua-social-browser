/**
 * Channel names and payloads shared by the main process, the privileged
 * preload, and the toolbar.
 *
 * The renderer-facing shapes mirror
 * `artifacts/ua-social-browser/src/lib/shell-bridge.ts`, which is the source of
 * truth for the contract. The two packages cannot import from each other (leaf
 * workspace packages, different runtimes), so any change there has to be
 * mirrored here — the shell's own test suite asserts the field names.
 */

export const CHANNELS = {
  surfaceAttach: "ua-shell:surface:attach",
  surfaceBounds: "ua-shell:surface:bounds",
  surfaceNavigate: "ua-shell:surface:navigate",
  surfaceReload: "ua-shell:surface:reload",
  surfaceClose: "ua-shell:surface:close",
  tabOpen: "ua-shell:tab:open",
  sessionStatus: "ua-shell:session:status",
  chromeState: "ua-shell:chrome:state",
  chromeCommand: "ua-shell:chrome:command",
} as const;

/** Version reported as `window.uaShell.version`. */
export const BRIDGE_VERSION = "1.0.0";

export type Rect = { x: number; y: number; width: number; height: number };

export type SurfaceOptions = {
  workspaceId: string;
  url: string;
  userAgent: string;
  acceptLanguage: string;
  timezone: string;
  clientHints: boolean;
};

/**
 * The partition is derived by the shell and reported back, never supplied by
 * the page: only the main process can decide which cookie jar a workspace gets.
 */
export type SurfaceAttachResult = {
  id: string;
  partition: string;
};

export type ShellSessionStatus = {
  workspaceId: string;
  authenticated: boolean;
  accountHandle?: string;
  detail: string;
};

export type ChromeTab = {
  id: string;
  title: string;
  url: string;
  active: boolean;
  workspaceName: string;
};

export type ChromeState = {
  workspaceId: string | null;
  workspaceName: string;
  /** Human label for the UA profile in force, e.g. "Chrome 131 · macOS". */
  profileLabel: string;
  profileName: string | null;
  timezone: string | null;
  address: string | null;
  tabs: ChromeTab[];
  canGoBack: boolean;
  canGoForward: boolean;
  /** True while a workspace tab covers the sidebar. */
  tabActive: boolean;
};

export type ChromeCommand =
  | { kind: "tab:select"; tabId: string }
  | { kind: "tab:close"; tabId: string }
  | { kind: "tab:back" }
  | { kind: "tab:forward" }
  | { kind: "tab:reload" }
  | { kind: "workspace:show" };
