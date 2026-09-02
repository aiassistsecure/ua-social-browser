/**
 * Contract between the privileged sidebar page and the native shell.
 *
 * The shell injects `window.uaShell` into this page only. Page content loaded
 * inside a workspace surface never receives it, so a social network cannot
 * reach the workspace API, the UA profile table, or the publisher.
 *
 * On the web development surface `window.uaShell` is absent. Every consumer
 * must handle that explicitly rather than pretending a session exists.
 */

export type ShellSessionStatus = {
  workspaceId: string;
  authenticated: boolean;
  accountHandle?: string;
  detail: string;
};

export type ShellSurfaceOptions = {
  workspaceId: string;
  /** Partition key: one isolated cookie/storage jar per workspace. */
  partition: string;
  url: string;
  userAgent: string;
  acceptLanguage: string;
  timezone: string;
  clientHints: boolean;
};

export type ShellSurfaceHandle = {
  id: string;
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
};

export type UAShellBridge = {
  readonly version: string;
  /** Mounts a workspace-isolated browsing surface into the given element. */
  attachSurface(
    container: HTMLElement,
    options: ShellSurfaceOptions,
  ): Promise<ShellSurfaceHandle>;
  /** Opens the platform in a normal workspace tab. */
  openInWorkspaceTab(workspaceId: string, url: string): Promise<void>;
  getSessionStatus(workspaceId: string): Promise<ShellSessionStatus>;
};

declare global {
  interface Window {
    uaShell?: UAShellBridge;
  }
}

export function getShell(): UAShellBridge | null {
  return typeof window !== 'undefined' && window.uaShell ? window.uaShell : null;
}

export function isShellAvailable(): boolean {
  return getShell() !== null;
}
