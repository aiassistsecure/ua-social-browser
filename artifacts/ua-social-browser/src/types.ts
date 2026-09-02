export type Section =
  | 'dashboard'
  | 'composer'
  | 'drafts'
  | 'calendar'
  | 'accounts'
  | 'profiles'
  | 'usage'
  | 'settings';

export type Platform = 'linkedin' | 'x' | 'instagram' | 'facebook' | 'threads';

export interface UAProfile {
  id: string;
  name: string;
  platform: string;
  userAgent: string;
  viewport: string;
  locale: string;
  timezone: string;
  clientHints: boolean;
  color: string;
}

export interface Workspace {
  id: string;
  name: string;
  profileId: string;
  platform: Platform;
  accountHandle: string;
  status: 'ready' | 'attention' | 'offline';
  accent: string;
  lastActive: string;
}

export interface SocialAccount {
  id: string;
  workspaceId: string;
  platform: Platform;
  handle: string;
  displayName: string;
  connected: boolean;
  avatar: string;
}

export interface Draft {
  id: string;
  workspaceId: string;
  platform: Platform;
  body: string;
  status: 'draft' | 'scheduled' | 'published';
  scheduledFor: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Activity {
  id: string;
  title: string;
  detail: string;
  timestamp: string;
  type: 'ai' | 'draft' | 'workspace' | 'publish';
}

export interface BrowserState {
  version: number;
  activeWorkspaceId: string;
  workspaces: Workspace[];
  uaProfiles: UAProfile[];
  drafts: Draft[];
  accounts: SocialAccount[];
  activity: Activity[];
  settings: {
    theme: 'dark';
    confirmBeforePublish: boolean;
    storeAiPrompts: boolean;
    model: string;
    provider: 'pin';
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    requests: number;
  };
  updatedAt: string;
}