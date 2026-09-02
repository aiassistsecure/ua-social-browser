/**
 * The browser window: chrome on top, workspace UI below, native views mounted
 * over it.
 *
 * Layout is deliberately explicit rather than nested webviews:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ toolbar  (workspace name · UA profile · tabs)│  48px, its own view
 *   ├──────────────────────────────────────────────┤
 *   │ privileged workspace UI                      │
 *   │   └─ surface views positioned over it        │
 *   │ …or a workspace tab covering the whole area  │
 *   └──────────────────────────────────────────────┘
 *
 * The toolbar is not decoration. An operator running several identities has to
 * be able to tell, at a glance and at all times, which workspace and which UA
 * profile the thing in front of them is using.
 */

import { randomUUID } from "node:crypto";
import { BaseWindow, WebContentsView, type WebContents } from "electron";
import type {
  ChromeCommand,
  ChromeState,
  ChromeTab,
  Rect,
  SurfaceAttachResult,
  SurfaceOptions,
} from "./ipc";
import { CHANNELS } from "./ipc";
import {
  applyEmulation,
  contextFor,
  detachEmulation,
  identityFrom,
  partitionFor,
  type WorkspaceIdentity,
} from "./workspace-contexts";
import { describeUserAgent } from "./ua-metadata";
import type { WorkspaceDirectory } from "./workspace-directory";
import { createLogger, errorFields } from "./logger";

const log = createLogger("window");

export const TOOLBAR_HEIGHT = 48;

type Surface = {
  id: string;
  view: WebContentsView;
  identity: WorkspaceIdentity;
  bounds: Rect;
};

type Tab = {
  id: string;
  view: WebContentsView;
  identity: WorkspaceIdentity;
  title: string;
  url: string;
};

export type ShellWindowOptions = {
  workspaceUiUrl: string;
  privilegedPreload: string;
  toolbarPreload: string;
  toolbarHtml: string;
  directory: WorkspaceDirectory;
};

export class ShellWindow {
  readonly window: BaseWindow;
  private readonly toolbar: WebContentsView;
  private readonly ui: WebContentsView;
  private readonly surfaces = new Map<string, Surface>();
  private readonly tabs: Tab[] = [];
  private activeTabId: string | null = null;
  private lastSurfaceWorkspaceId: string | null = null;

  constructor(private readonly options: ShellWindowOptions) {
    this.window = new BaseWindow({
      width: 1440,
      height: 960,
      minWidth: 960,
      minHeight: 640,
      title: "UA Social Browser",
      backgroundColor: "#0b0b0f",
      show: false,
    });

    this.toolbar = new WebContentsView({
      webPreferences: {
        preload: options.toolbarPreload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    this.ui = new WebContentsView({
      webPreferences: {
        preload: options.privilegedPreload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });

    this.window.contentView.addChildView(this.toolbar);
    this.window.contentView.addChildView(this.ui);

    this.guardPrivilegedView();

    void this.toolbar.webContents.loadFile(options.toolbarHtml);
    void this.ui.webContents.loadURL(options.workspaceUiUrl);

    this.toolbar.webContents.on("did-finish-load", () => this.publishChromeState());
    this.window.on("resize", () => this.layout());
    this.window.on("closed", () => this.disposeAll());

    this.layout();
    this.window.show();
  }

  /** The webContents allowed to speak to the privileged IPC handlers. */
  get privilegedContentsId(): number {
    return this.ui.webContents.id;
  }

  private guardPrivilegedView(): void {
    const uiOrigin = safeOrigin(this.options.workspaceUiUrl);
    const contents = this.ui.webContents;

    // The privileged page is the one page in the app with window.uaShell. It
    // must never become a social network: if it navigated away, that network
    // would inherit the bridge.
    contents.on("will-navigate", (event, url) => {
      if (safeOrigin(url) === uiOrigin) return;
      event.preventDefault();
      log.warn("Blocked navigation away from the privileged view", { url });
      void this.openTabForActiveWorkspace(url);
    });

    contents.setWindowOpenHandler(({ url }) => {
      void this.openTabForActiveWorkspace(url);
      return { action: "deny" };
    });

    contents.on("render-process-gone", (_event, details) => {
      log.error("The privileged view crashed", { reason: details.reason });
    });
  }

  private async openTabForActiveWorkspace(url: string): Promise<void> {
    const workspaceId =
      this.activeTab()?.identity.workspaceId ??
      this.lastSurfaceWorkspaceId ??
      this.options.directory.current.activeWorkspaceId;

    if (!workspaceId) {
      log.warn("No workspace to open this link in", { url });
      return;
    }

    try {
      await this.openTab(workspaceId, url);
    } catch (error) {
      log.error("Could not open a workspace tab", { url, ...errorFields(error) });
    }
  }

  // ---------------------------------------------------------------------
  // Surfaces
  // ---------------------------------------------------------------------

  async attachSurface(options: SurfaceOptions, bounds: Rect): Promise<SurfaceAttachResult> {
    // The partition comes from the workspace id alone, decided here. Nothing
    // the page sends can point a surface at another workspace's cookie jar.
    const identity = identityFrom({
      workspaceId: options.workspaceId,
      userAgent: options.userAgent,
      acceptLanguage: options.acceptLanguage,
      timezone: options.timezone,
      clientHints: options.clientHints,
    });

    const context = contextFor(identity);
    const view = new WebContentsView({
      webPreferences: {
        session: context,
        // No preload, no node, no bridge: this is a social network's page.
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    const surface: Surface = { id: randomUUID(), view, identity, bounds };
    this.surfaces.set(surface.id, surface);
    this.lastSurfaceWorkspaceId = identity.workspaceId;

    this.window.contentView.addChildView(view);
    this.wireContentView(view.webContents, identity);

    await applyEmulation(view.webContents, identity);
    this.layout();
    void view.webContents.loadURL(options.url);
    this.publishChromeState();

    log.info("Surface attached", {
      workspaceId: identity.workspaceId,
      partition: identity.partition,
      url: options.url,
    });

    return { id: surface.id, partition: identity.partition };
  }

  setSurfaceBounds(id: string, bounds: Rect): void {
    const surface = this.surfaces.get(id);
    if (!surface) return;
    surface.bounds = bounds;
    this.layout();
  }

  navigateSurface(id: string, url: string): void {
    const surface = this.surfaces.get(id);
    if (!surface) throw new Error(`No surface ${id}`);
    void surface.view.webContents.loadURL(url);
  }

  reloadSurface(id: string): void {
    const surface = this.surfaces.get(id);
    if (!surface) throw new Error(`No surface ${id}`);
    surface.view.webContents.reload();
  }

  closeSurface(id: string): void {
    const surface = this.surfaces.get(id);
    if (!surface) return;
    this.surfaces.delete(id);
    this.window.contentView.removeChildView(surface.view);
    detachEmulation(surface.view.webContents);
    surface.view.webContents.close();
    this.layout();
    this.publishChromeState();
  }

  // ---------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------

  async openTab(workspaceId: string, url: string): Promise<string> {
    const identity = await this.identityForWorkspace(workspaceId);
    const context = contextFor(identity);

    const view = new WebContentsView({
      webPreferences: {
        session: context,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    const tab: Tab = { id: randomUUID(), view, identity, title: url, url };
    this.tabs.push(tab);
    this.activeTabId = tab.id;

    this.window.contentView.addChildView(view);
    this.wireContentView(view.webContents, identity);

    view.webContents.on("page-title-updated", (_event, title) => {
      tab.title = title;
      this.publishChromeState();
    });
    const trackUrl = () => {
      tab.url = view.webContents.getURL();
      this.publishChromeState();
    };
    view.webContents.on("did-navigate", trackUrl);
    view.webContents.on("did-navigate-in-page", trackUrl);

    await applyEmulation(view.webContents, identity);
    this.layout();
    void view.webContents.loadURL(url);
    this.publishChromeState();

    log.info("Workspace tab opened", { workspaceId, url });
    return tab.id;
  }

  private activeTab(): Tab | null {
    return this.tabs.find((tab) => tab.id === this.activeTabId) ?? null;
  }

  private closeTab(tabId: string): void {
    const index = this.tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return;
    const [tab] = this.tabs.splice(index, 1) as [Tab];

    this.window.contentView.removeChildView(tab.view);
    detachEmulation(tab.view.webContents);
    tab.view.webContents.close();

    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabs[this.tabs.length - 1]?.id ?? null;
    }

    this.layout();
    this.publishChromeState();
  }

  handleChromeCommand(command: ChromeCommand): void {
    switch (command.kind) {
      case "tab:select":
        this.activeTabId = command.tabId;
        break;
      case "tab:close":
        this.closeTab(command.tabId);
        return;
      case "tab:back":
        this.activeTab()?.view.webContents.navigationHistory.goBack();
        break;
      case "tab:forward":
        this.activeTab()?.view.webContents.navigationHistory.goForward();
        break;
      case "tab:reload":
        this.activeTab()?.view.webContents.reload();
        break;
      case "workspace:show":
        this.activeTabId = null;
        break;
    }
    this.layout();
    this.publishChromeState();
  }

  // ---------------------------------------------------------------------
  // Shared plumbing
  // ---------------------------------------------------------------------

  private wireContentView(contents: WebContents, identity: WorkspaceIdentity): void {
    // A link that wants a new window becomes a tab in the same workspace, so a
    // popup can never escape into another workspace's session.
    contents.setWindowOpenHandler(({ url }) => {
      void this.openTab(identity.workspaceId, url).catch((error: unknown) =>
        log.error("Popup could not become a tab", { url, ...errorFields(error) }),
      );
      return { action: "deny" };
    });

    contents.on("did-navigate", () => this.publishChromeState());
  }

  private async identityForWorkspace(workspaceId: string): Promise<WorkspaceIdentity> {
    for (const surface of this.surfaces.values()) {
      if (surface.identity.workspaceId === workspaceId) return surface.identity;
    }

    const entry = await this.options.directory.resolve(workspaceId);
    if (!entry) {
      throw new Error(`The shell does not know a workspace called "${workspaceId}".`);
    }

    return identityFrom({
      workspaceId,
      userAgent: entry.profile?.userAgent ?? "",
      acceptLanguage: entry.profile?.acceptLanguage ?? "en-US",
      timezone: entry.profile?.timezone ?? "UTC",
      clientHints: entry.profile?.clientHints ?? false,
    });
  }

  private layout(): void {
    const { width, height } = this.window.getContentBounds();
    const contentHeight = Math.max(0, height - TOOLBAR_HEIGHT);

    this.toolbar.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });

    const activeTab = this.activeTab();
    const full = { x: 0, y: TOOLBAR_HEIGHT, width, height: contentHeight };

    for (const tab of this.tabs) {
      const active = tab.id === this.activeTabId;
      tab.view.setVisible(active);
      if (active) tab.view.setBounds(full);
    }

    this.ui.setVisible(activeTab === null);
    if (activeTab === null) this.ui.setBounds(full);

    for (const surface of this.surfaces.values()) {
      surface.view.setVisible(activeTab === null);
      if (activeTab !== null) continue;
      surface.view.setBounds(clampToContent(surface.bounds, width, contentHeight));
    }
  }

  publishChromeState(): void {
    if (this.toolbar.webContents.isDestroyed()) return;

    const activeTab = this.activeTab();
    const directory = this.options.directory.current;

    const workspaceId =
      activeTab?.identity.workspaceId ??
      this.lastSurfaceWorkspaceId ??
      directory.activeWorkspaceId;

    const entry = workspaceId
      ? directory.workspaces.find((candidate) => candidate.id === workspaceId)
      : undefined;

    const identity =
      activeTab?.identity ??
      [...this.surfaces.values()].find((surface) => surface.identity.workspaceId === workspaceId)
        ?.identity;

    const userAgent = identity?.userAgent ?? entry?.profile?.userAgent ?? "";

    const tabs: ChromeTab[] = this.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title || tab.url,
      url: tab.url,
      active: tab.id === this.activeTabId,
      workspaceName:
        directory.workspaces.find((candidate) => candidate.id === tab.identity.workspaceId)?.name ??
        tab.identity.workspaceId,
    }));

    const state: ChromeState = {
      workspaceId: workspaceId ?? null,
      workspaceName: entry?.name ?? workspaceId ?? "No workspace",
      profileLabel: userAgent ? describeUserAgent(userAgent) : "Shell default UA",
      profileName: entry?.profile?.name ?? null,
      timezone: identity?.timezone ?? entry?.profile?.timezone ?? null,
      address: activeTab?.url ?? null,
      tabs,
      canGoBack: activeTab?.view.webContents.navigationHistory.canGoBack() ?? false,
      canGoForward: activeTab?.view.webContents.navigationHistory.canGoForward() ?? false,
      tabActive: activeTab !== null,
    };

    this.toolbar.webContents.send(CHANNELS.chromeState, state);
  }

  private disposeAll(): void {
    for (const id of [...this.surfaces.keys()]) this.closeSurface(id);
    for (const tab of [...this.tabs]) this.closeTab(tab.id);
  }
}

function clampToContent(bounds: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(bounds.x, width));
  const y = Math.max(0, Math.min(bounds.y, height));
  return {
    x,
    y: y + TOOLBAR_HEIGHT,
    width: Math.max(0, Math.min(bounds.width, width - x)),
    height: Math.max(0, Math.min(bounds.height, height - y)),
  };
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
