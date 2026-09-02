import { useState } from 'react';
import { Link2, Link2Off, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PlatformGlyph } from '@/components/app/platform-glyph';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { SectionShell, type SectionProps } from '@/sections/section-shell';
import {
  PLATFORMS,
  PLATFORM_LABEL,
  createId,
  initialsFor,
  logActivity,
} from '@/lib/workspace';
import type { Platform } from '@/types';

export function Accounts({ state, updateState, workspace }: SectionProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [platform, setPlatform] = useState<Platform>(workspace.platform);

  const accounts = state.accounts.filter(
    (account) => account.workspaceId === workspace.id,
  );

  function toggleConnection(accountId: string) {
    updateState((current) => {
      const account = current.accounts.find((item) => item.id === accountId);
      if (!account) return current;
      const connected = !account.connected;
      return {
        ...current,
        accounts: current.accounts.map((item) =>
          item.id === accountId ? { ...item, connected } : item,
        ),
        activity: logActivity(current, {
          type: 'workspace',
          title: connected ? 'Account linked' : 'Account unlinked',
          detail: `${account.handle} · ${workspace.name}`,
        }),
      };
    });
  }

  function removeAccount(accountId: string) {
    updateState((current) => ({
      ...current,
      accounts: current.accounts.filter((item) => item.id !== accountId),
    }));
  }

  function addAccount() {
    const normalizedHandle = handle.trim();
    const normalizedName = displayName.trim();
    if (!normalizedHandle || !normalizedName) {
      toast({
        title: 'Handle and display name are required',
        variant: 'destructive',
      });
      return;
    }

    updateState((current) => ({
      ...current,
      accounts: [
        ...current.accounts,
        {
          id: createId('account'),
          workspaceId: workspace.id,
          platform,
          handle: normalizedHandle.startsWith('@')
            ? normalizedHandle
            : `@${normalizedHandle}`,
          displayName: normalizedName,
          connected: false,
          avatar: initialsFor(normalizedName),
        },
      ],
      activity: logActivity(current, {
        type: 'workspace',
        title: 'Account added',
        detail: `${normalizedHandle} · ${workspace.name}`,
      }),
    }));

    setHandle('');
    setDisplayName('');
    setOpen(false);
  }

  return (
    <SectionShell
      title="Accounts"
      description={`Accounts registered to ${workspace.name}. Sign-in happens in the workspace's own browsing context, so credentials and cookies stay inside this profile.`}
      actions={
        <Button onClick={() => setOpen(true)} data-testid="button-add-account">
          <Plus className="mr-2 h-4 w-4" />
          Add account
        </Button>
      }
    >
      {accounts.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            No accounts registered to this workspace yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {accounts.map((account) => (
            <Card key={account.id} data-testid={`account-${account.id}`}>
              <CardContent className="flex items-center gap-3 p-4">
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
                  style={{
                    backgroundColor: `${workspace.accent}22`,
                    color: workspace.accent,
                  }}
                >
                  {account.avatar}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {account.displayName}
                  </p>
                  <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                    <PlatformGlyph
                      platform={account.platform}
                      className="h-3 w-3"
                    />
                    {account.handle}
                  </p>
                </div>
                <span
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide',
                    account.connected
                      ? 'border-chart-2/50 text-chart-2'
                      : 'border-border text-muted-foreground',
                  )}
                >
                  {account.connected ? 'Linked' : 'Not linked'}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label={account.connected ? 'Unlink' : 'Link'}
                    onClick={() => toggleConnection(account.id)}
                    data-testid={`button-toggle-${account.id}`}
                  >
                    {account.connected ? (
                      <Link2Off className="h-4 w-4" />
                    ) : (
                      <Link2 className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label="Remove account"
                    onClick={() => removeAccount(account.id)}
                    data-testid={`button-remove-${account.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">What this browser will not do</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
          <p>· No credential storage outside the OS keychain and profile jar.</p>
          <p>· No automated posting, liking, following, or messaging.</p>
          <p>· No CAPTCHA solving or anti-detection evasion.</p>
          <p>· No scraping of another user's private data.</p>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add an account</DialogTitle>
            <DialogDescription>
              Registers the account with this workspace. You still sign in
              yourself inside the workspace's browsing context.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="account-platform">Platform</Label>
              <Select
                value={platform}
                onValueChange={(value) => setPlatform(value as Platform)}
              >
                <SelectTrigger id="account-platform" data-testid="select-account-platform">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {PLATFORM_LABEL[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="account-name">Display name</Label>
              <Input
                id="account-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Northstar Studio"
                data-testid="input-account-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="account-handle">Handle</Label>
              <Input
                id="account-handle"
                value={handle}
                onChange={(event) => setHandle(event.target.value)}
                placeholder="@northstar.studio"
                data-testid="input-account-handle"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={addAccount} data-testid="button-save-account">
              Add account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionShell>
  );
}
