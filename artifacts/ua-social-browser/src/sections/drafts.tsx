import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  CalendarClock,
  ExternalLink,
  Loader2,
  RotateCcw,
  Send,
  Trash2,
} from 'lucide-react';
import { usePublishPost } from '@workspace/api-client-react';
import type { PublishRequestPlatform } from '@workspace/api-client-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { PlatformGlyph } from '@/components/app/platform-glyph';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { SectionShell, type SectionProps } from '@/sections/section-shell';
import { platformProfile } from '@/lib/platforms';
import {
  draftsForWorkspace,
  formatDateTime,
  fromLocalInputValue,
  logActivity,
  relativeTime,
  toLocalInputValue,
} from '@/lib/workspace';
import type { Draft, DraftStatus } from '@/types';

type Filter = 'all' | 'pending' | 'approved' | 'published';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Needs review' },
  { id: 'approved', label: 'Approved' },
  { id: 'published', label: 'Posted' },
];

const STATUS_STYLE: Record<DraftStatus, string> = {
  draft: 'border-border text-muted-foreground',
  approved: 'border-primary/50 text-primary',
  scheduled: 'border-chart-4/50 text-chart-4',
  publishing: 'border-chart-3/50 text-chart-3',
  published: 'border-chart-2/50 text-chart-2',
  failed: 'border-destructive/50 text-destructive',
};

const STATUS_LABEL: Record<DraftStatus, string> = {
  draft: 'Needs review',
  approved: 'Approved',
  scheduled: 'Scheduled',
  publishing: 'Posting',
  published: 'Posted',
  failed: 'Failed',
};

function matchesFilter(draft: Draft, filter: Filter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'pending':
      return draft.status === 'draft' || draft.status === 'failed';
    case 'approved':
      return draft.status === 'approved' || draft.status === 'scheduled';
    case 'published':
      return draft.status === 'published';
  }
}

/** The publish endpoint returns its reason in the error body. */
function failureMessage(error: unknown): string {
  const data = (error as { data?: { message?: string; error?: string } })?.data;
  return (
    data?.message ??
    data?.error ??
    'The post could not be sent. Nothing was published.'
  );
}

/** How long a post arrived at from the calendar stays visibly marked. */
const FOCUS_HIGHLIGHT_MS = 4_000;

export function Drafts({
  state,
  updateState,
  workspace,
  focusedDraftId,
  onFocusHandled,
}: SectionProps & {
  /** A post the operator clicked elsewhere — scroll to it and mark it. */
  focusedDraftId?: string | null;
  onFocusHandled?: () => void;
}) {
  const { toast } = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [pendingPublish, setPendingPublish] = useState<Draft | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const publishPost = usePublishPost();

  const operator = state.settings.operatorName.trim() || 'Operator';
  const drafts = draftsForWorkspace(state, workspace.id).filter((draft) =>
    matchesFilter(draft, filter),
  );

  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const focusHandled = useRef(onFocusHandled);
  focusHandled.current = onFocusHandled;

  // A post arrived at from the calendar may be filtered out of this view, so
  // widen the filter first and scroll to it once it is actually on screen.
  useEffect(() => {
    if (focusedDraftId) setFilter('all');
  }, [focusedDraftId]);

  useEffect(() => {
    if (!focusedDraftId) return;

    cardRefs.current
      .get(focusedDraftId)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const timer = window.setTimeout(
      () => focusHandled.current?.(),
      FOCUS_HIGHLIGHT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [focusedDraftId, filter]);

  function patchDraft(id: string, patch: Partial<Draft>) {
    updateState((current) => ({
      ...current,
      drafts: current.drafts.map((draft) =>
        draft.id === id
          ? { ...draft, ...patch, updatedAt: new Date().toISOString() }
          : draft,
      ),
    }));
  }

  function approve(draft: Draft) {
    patchDraft(draft.id, {
      status: draft.scheduledFor ? 'scheduled' : 'approved',
      approvedBy: operator,
      approvedAt: new Date().toISOString(),
      lastError: null,
    });
    updateState((current) => ({
      ...current,
      activity: logActivity(current, {
        type: 'draft',
        title: 'Approved by a human',
        detail: `${platformProfile(draft.platform).label} · ${operator}`,
      }),
    }));
  }

  function revokeApproval(draft: Draft) {
    patchDraft(draft.id, {
      status: 'draft',
      approvedBy: null,
      approvedAt: null,
      scheduledFor: null,
    });
  }

  function removeDraft(draft: Draft) {
    updateState((current) => ({
      ...current,
      drafts: current.drafts.filter((item) => item.id !== draft.id),
      activity: logActivity(current, {
        type: 'draft',
        title: 'Draft discarded',
        detail: `${platformProfile(draft.platform).label} · ${workspace.name}`,
      }),
    }));
    toast({ title: 'Draft discarded' });
  }

  function schedule(draft: Draft, value: string) {
    const scheduledFor = fromLocalInputValue(value);
    if (!scheduledFor) return;
    patchDraft(draft.id, {
      scheduledFor,
      status: draft.approvedAt ? 'scheduled' : draft.status,
    });
  }

  /**
   * Most posts go out the moment the operator presses Post, so that is the
   * default and a time is the exception. Turning the clock off clears the time
   * rather than remembering it: a stored time nobody can see is the kind of
   * thing that sends a post at 3am a week later.
   */
  function setImmediate(draft: Draft, immediate: boolean) {
    if (immediate) {
      patchDraft(draft.id, {
        scheduledFor: null,
        status: draft.status === 'scheduled' ? 'approved' : draft.status,
      });
      return;
    }

    // The same value the picker shows when it is empty, so the operator sees
    // exactly the time they are agreeing to.
    const suggested = fromLocalInputValue(toLocalInputValue(null));
    patchDraft(draft.id, {
      scheduledFor: suggested,
      status: draft.approvedAt && suggested ? 'scheduled' : draft.status,
    });
  }

  function requestPublish(draft: Draft) {
    if (!draft.approvedAt) {
      toast({
        title: 'Approval required',
        description: 'A person has to sign off before anything reaches the network.',
        variant: 'destructive',
      });
      return;
    }
    if (state.settings.confirmBeforePublish) {
      setPendingPublish(draft);
      return;
    }
    void send(draft);
  }

  async function send(draft: Draft) {
    setPendingPublish(null);
    setSendingId(draft.id);
    patchDraft(draft.id, { status: 'publishing', lastError: null });

    try {
      const result = await publishPost.mutateAsync({
        data: {
          workspaceId: workspace.id,
          draftId: draft.id,
          platform: draft.platform as PublishRequestPlatform,
          body: draft.body,
          approval: {
            approvedBy: draft.approvedBy ?? operator,
            approvedAt: draft.approvedAt ?? new Date().toISOString(),
          },
          // No idempotency key: the server derives it from the stored draft and
          // its approval, and refuses a different one. Sending our own could
          // only ever disagree with the record and be refused.
        },
      });

      patchDraft(draft.id, {
        status: 'published',
        postUrl: result.postUrl ?? null,
        lastError: null,
      });
      updateState((current) => ({
        ...current,
        activity: logActivity(current, {
          type: 'publish',
          title: 'Posted through your session',
          detail: `${platformProfile(draft.platform).label} · ${workspace.name}`,
        }),
      }));
      toast({
        title: `Posted to ${platformProfile(draft.platform).label}`,
        description: result.message ?? 'Sent from your own signed-in session.',
      });
    } catch (error) {
      const message = failureMessage(error);
      patchDraft(draft.id, { status: 'failed', lastError: message });
      updateState((current) => ({
        ...current,
        activity: logActivity(current, {
          type: 'publish',
          title: 'Publish attempt failed',
          detail: message,
        }),
      }));
      toast({
        title: 'Not posted',
        description: message,
        variant: 'destructive',
      });
    } finally {
      setSendingId(null);
    }
  }

  return (
    <SectionShell
      title="Review queue"
      description="The model drafts, you approve, and the post leaves from your own signed-in session on the network — when you press Post, or at the time you set. Nothing here reaches an audience without an approval attached to it."
      actions={
        <div className="flex items-center gap-1 rounded-md border border-border p-1">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setFilter(option.id)}
              className={cn(
                'rounded px-2.5 py-1 text-xs transition-colors hover-elevate',
                filter === option.id
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground',
              )}
              data-testid={`filter-${option.id}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      }
    >
      {drafts.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Nothing in this view yet.
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {drafts.map((draft) => {
            const network = platformProfile(draft.platform);
            const overLimit = draft.body.length > network.charLimit;
            const locked =
              draft.status === 'published' || draft.status === 'publishing';
            const isSending = sendingId === draft.id;
            const approved = Boolean(draft.approvedAt);
            // No time set is not an unfinished schedule — it is the normal
            // case: it goes out when a person presses Post.
            const immediate = draft.scheduledFor === null;

            return (
              <Card
                key={draft.id}
                ref={(node) => {
                  if (node) cardRefs.current.set(draft.id, node);
                  else cardRefs.current.delete(draft.id);
                }}
                className={cn(
                  focusedDraftId === draft.id &&
                    'ring-2 ring-primary ring-offset-2 ring-offset-background',
                )}
                data-testid={`draft-${draft.id}`}
              >
                <CardContent className="space-y-3 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <PlatformGlyph platform={draft.platform} tinted />
                    <span className="text-sm font-medium">{network.label}</span>
                    <span
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide',
                        STATUS_STYLE[draft.status],
                      )}
                    >
                      {STATUS_LABEL[draft.status]}
                    </span>
                    {approved ? (
                      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <BadgeCheck className="h-3.5 w-3.5 text-chart-2" />
                        {draft.approvedBy} · {relativeTime(draft.approvedAt!)}
                      </span>
                    ) : null}
                    <span className="ml-auto text-xs text-muted-foreground">
                      Updated {relativeTime(draft.updatedAt)}
                    </span>
                  </div>

                  <Textarea
                    value={draft.body}
                    readOnly={locked}
                    onChange={(event) =>
                      patchDraft(draft.id, {
                        body: event.target.value,
                        // Editing after approval invalidates the sign-off.
                        ...(approved && draft.status !== 'published'
                          ? {
                              status: 'draft' as const,
                              approvedBy: null,
                              approvedAt: null,
                            }
                          : {}),
                      })
                    }
                    className="min-h-[110px] resize-y"
                    data-testid={`input-body-${draft.id}`}
                  />

                  {draft.status === 'failed' && draft.lastError ? (
                    <div
                      className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                      data-testid={`error-${draft.id}`}
                    >
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{draft.lastError}</span>
                    </div>
                  ) : null}

                  {draft.status === 'published' && draft.postUrl ? (
                    <a
                      href={draft.postUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-sm text-chart-2 underline underline-offset-2"
                      data-testid={`link-post-${draft.id}`}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      View it on {network.label}
                    </a>
                  ) : null}

                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id={`immediate-${draft.id}`}
                            checked={immediate}
                            disabled={locked}
                            onCheckedChange={(checked) =>
                              setImmediate(draft, checked === true)
                            }
                            data-testid={`checkbox-immediate-${draft.id}`}
                          />
                          <Label
                            htmlFor={`immediate-${draft.id}`}
                            className="text-xs font-normal"
                          >
                            Post immediately
                          </Label>
                        </div>

                        {!immediate ? (
                          <div className="space-y-1">
                            <Label
                              htmlFor={`schedule-${draft.id}`}
                              className="text-xs text-muted-foreground"
                            >
                              Send at
                            </Label>
                            <Input
                              id={`schedule-${draft.id}`}
                              type="datetime-local"
                              disabled={locked}
                              value={toLocalInputValue(draft.scheduledFor)}
                              onChange={(event) =>
                                schedule(draft, event.target.value)
                              }
                              className="h-9 w-[210px]"
                              data-testid={`input-schedule-${draft.id}`}
                            />
                          </div>
                        ) : null}
                      </div>
                      <span
                        className={cn(
                          'pb-2 text-xs tabular-nums',
                          overLimit
                            ? 'font-medium text-destructive'
                            : 'text-muted-foreground',
                        )}
                      >
                        {draft.body.length} / {network.charLimit}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      {!locked ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeDraft(draft)}
                          data-testid={`button-delete-${draft.id}`}
                        >
                          <Trash2 className="mr-2 h-3.5 w-3.5" />
                          Discard
                        </Button>
                      ) : null}

                      {!approved && draft.status !== 'published' ? (
                        <Button
                          size="sm"
                          disabled={overLimit || locked}
                          onClick={() => approve(draft)}
                          data-testid={`button-approve-${draft.id}`}
                        >
                          <BadgeCheck className="mr-2 h-3.5 w-3.5" />
                          Approve
                        </Button>
                      ) : null}

                      {approved && draft.status !== 'published' ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => revokeApproval(draft)}
                            disabled={isSending}
                            data-testid={`button-revoke-${draft.id}`}
                          >
                            <RotateCcw className="mr-2 h-3.5 w-3.5" />
                            Revoke
                          </Button>
                          <Button
                            size="sm"
                            disabled={overLimit || isSending}
                            onClick={() => requestPublish(draft)}
                            data-testid={`button-publish-${draft.id}`}
                          >
                            {isSending ? (
                              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Send className="mr-2 h-3.5 w-3.5" />
                            )}
                            {isSending ? 'Posting' : `Post to ${network.label}`}
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>

                  {immediate && approved && draft.status !== 'published' ? (
                    <>
                      <Separator />
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Send className="h-3.5 w-3.5" />
                        No time set: this goes out when you press Post to{' '}
                        {network.label}, and not before. Tick the box off to
                        give it a time instead.
                      </p>
                    </>
                  ) : null}

                  {draft.status === 'scheduled' && draft.scheduledFor ? (
                    <>
                      <Separator />
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <CalendarClock className="h-3.5 w-3.5" />
                        Goes out on its own at{' '}
                        {formatDateTime(draft.scheduledFor)}, through this
                        workspace's session and under this approval. Edit the
                        text and the approval drops, so it stays put. One
                        attempt per time you set: if it fails, the reason lands
                        here rather than a silent retry — set a new time to try
                        again.
                      </p>
                    </>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <AlertDialog
        open={pendingPublish !== null}
        onOpenChange={(open) => {
          if (!open) setPendingPublish(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Post to{' '}
              {pendingPublish
                ? platformProfile(pendingPublish.platform).label
                : ''}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This sends the post through your signed-in session in this
              workspace, under {pendingPublish?.approvedBy ?? operator}'s
              approval. It becomes public immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-publish">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pendingPublish && void send(pendingPublish)}
              data-testid="button-confirm-publish"
            >
              Post it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionShell>
  );
}
