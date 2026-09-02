import { useEffect, useRef, useState } from 'react';
import {
  Bell,
  ExternalLink,
  Loader2,
  MonitorSmartphone,
  PenLine,
  RefreshCw,
  ShieldCheck,
  ShieldX,
} from 'lucide-react';
import { useGetSessionStatus } from '@workspace/api-client-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { PlatformGlyph } from '@/components/app/platform-glyph';
import { SectionShell, type SectionProps } from '@/sections/section-shell';
import { platformProfile } from '@/lib/platforms';
import { createId, logActivity } from '@/lib/workspace';
import { getShell } from '@/lib/shell-bridge';

export function Network({ state, updateState, workspace, profile }: SectionProps) {
  const { toast } = useToast();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [surfaceState, setSurfaceState] = useState<
    'idle' | 'mounting' | 'mounted' | 'unavailable'
  >('idle');
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  const [quickNote, setQuickNote] = useState('');

  const network = platformProfile(workspace.platform);
  const sessionQuery = useGetSessionStatus({ workspaceId: workspace.id });
  const session = sessionQuery.data;

  useEffect(() => {
    const shell = getShell();
    const container = surfaceRef.current;
    if (!shell || !container || !profile) {
      setSurfaceState('unavailable');
      return;
    }

    let handle: { close(): Promise<void> } | null = null;
    let cancelled = false;
    setSurfaceState('mounting');
    setSurfaceError(null);

    shell
      .attachSurface(container, {
        workspaceId: workspace.id,
        partition: `persist:ua-${workspace.id}`,
        url: network.feedUrl,
        userAgent: profile.userAgent,
        acceptLanguage: profile.locale,
        timezone: profile.timezone,
        clientHints: profile.clientHints,
      })
      .then((mounted) => {
        if (cancelled) {
          void mounted.close();
          return;
        }
        handle = mounted;
        setSurfaceState('mounted');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSurfaceState('unavailable');
        setSurfaceError(
          error instanceof Error ? error.message : 'Surface failed to mount.',
        );
      });

    return () => {
      cancelled = true;
      void handle?.close();
    };
  }, [workspace.id, network.feedUrl, profile]);

  function openInTab(url: string) {
    const shell = getShell();
    if (shell) {
      void shell.openInWorkspaceTab(workspace.id, url);
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function captureNote() {
    const body = quickNote.trim();
    if (!body) return;

    updateState((current) => ({
      ...current,
      drafts: [
        {
          id: createId('draft'),
          workspaceId: workspace.id,
          platform: workspace.platform,
          body,
          status: 'draft',
          scheduledFor: null,
          approvedBy: null,
          approvedAt: null,
          postUrl: null,
          lastError: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        ...current.drafts,
      ],
      activity: logActivity(current, {
        type: 'draft',
        title: 'Captured from the network view',
        detail: `${network.label} · ${workspace.name}`,
      }),
    }));

    setQuickNote('');
    toast({
      title: 'Captured as a draft',
      description: 'Refine it in the composer, then approve it to post.',
    });
  }

  const sessionReady = Boolean(session?.authenticated);

  return (
    <SectionShell
      title={`${network.label} · ${workspace.name}`}
      description={network.note}
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => sessionQuery.refetch()}
            data-testid="button-refresh-session"
          >
            <RefreshCw
              className={cn(
                'mr-2 h-4 w-4',
                sessionQuery.isFetching && 'animate-spin',
              )}
            />
            Session
          </Button>
          {network.notificationsUrl ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => openInTab(network.notificationsUrl as string)}
              data-testid="button-open-notifications"
            >
              <Bell className="mr-2 h-4 w-4" />
              Notifications
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={() => openInTab(network.composeUrl)}
            data-testid="button-open-native-composer"
          >
            <ExternalLink className="mr-2 h-4 w-4" />
            Open {network.label}
          </Button>
        </>
      }
    >
      <div
        className="flex items-center gap-3 rounded-md border p-3 text-sm"
        style={{ borderColor: `${network.accent}55` }}
        data-testid="session-banner"
      >
        {sessionQuery.isLoading ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        ) : sessionReady ? (
          <ShieldCheck className="h-4 w-4 shrink-0 text-chart-2" />
        ) : (
          <ShieldX className="h-4 w-4 shrink-0 text-chart-3" />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {sessionQuery.isLoading
              ? 'Checking the workspace session'
              : sessionReady
                ? `Signed in${session?.accountHandle ? ` as ${session.accountHandle}` : ''}`
                : 'Not ready to post'}
          </p>
          <p className="text-xs text-muted-foreground">
            {sessionQuery.isError
              ? 'The workspace API did not answer. Posting is disabled until it does.'
              : (session?.detail ??
                'Session state is resolved by the desktop shell.')}
          </p>
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {profile?.name ?? 'No UA profile'}
        </span>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0 border-b border-card-border py-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <PlatformGlyph platform={workspace.platform} tinted />
            {network.feedUrl}
          </CardTitle>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            partition: persist:ua-{workspace.id}
          </span>
        </CardHeader>

        <CardContent className="p-0">
          <div
            ref={surfaceRef}
            className="min-h-[420px] w-full"
            data-testid="network-surface"
          >
            {surfaceState !== 'mounted' ? (
              <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 p-10 text-center">
                {surfaceState === 'mounting' ? (
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                ) : (
                  <MonitorSmartphone className="h-7 w-7 text-muted-foreground" />
                )}
                <p className="text-sm font-medium">
                  {surfaceState === 'mounting'
                    ? 'Mounting the isolated surface'
                    : 'The live network runs in the desktop shell'}
                </p>
                <p className="max-w-md text-sm text-muted-foreground">
                  {surfaceError ??
                    `${network.label} refuses to render inside a plain iframe, and faking it would be worse than not showing it. In the native shell this panel is a real Chromium view bound to this workspace's own cookie jar and UA profile.`}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openInTab(network.feedUrl)}
                  data-testid="button-open-feed"
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Open the feed
                </Button>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <PenLine className="h-4 w-4" />
              Quick capture
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={quickNote}
              onChange={(event) => setQuickNote(event.target.value)}
              placeholder={`Something you saw on ${network.label} worth replying to, or a thought to turn into a post later.`}
              className="min-h-[104px] resize-y"
              data-testid="input-quick-capture"
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs tabular-nums text-muted-foreground">
                {quickNote.length} / {network.charLimit}
              </span>
              <Button
                size="sm"
                onClick={captureNote}
                disabled={!quickNote.trim()}
                data-testid="button-capture"
              >
                Save as draft
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Network rules</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {[
              ['Character limit', network.charLimit.toLocaleString()],
              ['Media per post', String(network.mediaLimit)],
              ['Threads', network.supportsThread ? 'Supported' : 'No'],
              ['Alt text', network.supportsAltText ? 'Supported' : 'No'],
              ['Media required', network.requiresMedia ? 'Yes' : 'No'],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium">{value}</span>
              </div>
            ))}
            <Separator />
            <p className="text-xs text-muted-foreground">
              Drafts for this workspace:{' '}
              {
                state.drafts.filter(
                  (draft) => draft.workspaceId === workspace.id,
                ).length
              }
            </p>
          </CardContent>
        </Card>
      </div>
    </SectionShell>
  );
}
