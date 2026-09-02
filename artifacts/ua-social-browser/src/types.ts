export type Section =
  | 'dashboard'
  | 'network'
  | 'composer'
  | 'drafts'
  | 'calendar'
  | 'accounts'
  | 'profiles'
  | 'usage'
  | 'settings';

/** X is the primary network; the rest are first-class but secondary. */
export type Platform =
  | 'x'
  | 'instagram'
  | 'facebook'
  | 'threads'
  | 'linkedin'
  | 'bluesky'
  | 'mastodon'
  | 'reddit'
  | 'tiktok'
  | 'youtube'
  | 'pinterest'
  | 'tumblr';

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

/**
 * Lifecycle of a post.
 *
 * `draft`      — model output the operator kept, not yet signed off
 * `approved`   — a person approved it; it may now be sent
 * `scheduled`  — approved, with a time attached
 * `publishing` — handed to the workspace session, awaiting the platform
 * `published`  — the platform accepted it
 * `failed`     — the attempt failed; the reason is kept on the draft
 */
export type DraftStatus =
  | 'draft'
  | 'approved'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'failed';

/**
 * An attachment, as the draft carries it.
 *
 * A reference, never the bytes. The whole browser state document is written on
 * every edit, so an image inside it would be rewritten on every keystroke and
 * kept forever by the append-only ledger. The file itself lives under the data
 * directory, addressed by the hash of its contents, and that hash is what lets
 * the shell prove the file it uploads is the file that was approved.
 */
export interface DraftMedia {
  /** `<sha256>/<filename>`; also the path segment for `/api/media/`. */
  id: string;
  sha256: string;
  filename: string;
  mimeType: string;
  bytes: number;
  altText?: string;
}

export interface Draft {
  id: string;
  workspaceId: string;
  platform: Platform;
  body: string;
  media: DraftMedia[];
  status: DraftStatus;
  scheduledFor: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  postUrl: string | null;
  lastError: string | null;
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
    /** Recorded as the approver on every post this browser sends. */
    operatorName: string;
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
