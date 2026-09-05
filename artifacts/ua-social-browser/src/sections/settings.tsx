import { Download, RotateCcw, ShieldAlert, ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useListAiModels } from '@workspace/api-client-react';
import { initialState } from '@/data';
import { SectionShell, type SectionProps } from '@/sections/section-shell';

type SettingsProps = SectionProps & {
  integrity: { verified: boolean; sequence: number; head: string };
};

export function Settings({ state, updateState, integrity }: SettingsProps) {
  const modelsQuery = useListAiModels();
  const models = modelsQuery.data?.models ?? [];
  const options = models.some((model) => model.id === state.settings.model)
    ? models
    : [{ id: state.settings.model, name: state.settings.model }, ...models];

  const IntegrityIcon = integrity.verified ? ShieldCheck : ShieldAlert;

  return (
    <SectionShell
      title="Settings"
      description="Assistant defaults, review gates, and the state of the embedded store that backs every workspace."
    >
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Assistant</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="settings-operator">Approver name</Label>
            <Input
              id="settings-operator"
              value={state.settings.operatorName}
              onChange={(event) =>
                updateState((current) => ({
                  ...current,
                  settings: {
                    ...current.settings,
                    operatorName: event.target.value,
                  },
                }))
              }
              placeholder="Your name"
              className="max-w-sm"
              data-testid="input-operator-name"
            />
            <p className="text-xs text-muted-foreground">
              Recorded on every approval and sent with the post so the ledger
              shows who signed off. Nothing can be approved while this is
              empty, and approvals already recorded keep the name they were
              signed under.
            </p>
          </div>

          <Separator />

          <div className="space-y-1.5">
            <Label htmlFor="settings-model">Default model</Label>
            <Select
              value={state.settings.model}
              onValueChange={(value) =>
                updateState((current) => ({
                  ...current,
                  settings: { ...current.settings, model: value },
                }))
              }
            >
              <SelectTrigger
                id="settings-model"
                className="max-w-sm"
                data-testid="select-default-model"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Sent with the <code className="font-mono">pin</code> provider
              header from the server. Renderer processes never see the key.
            </p>
          </div>

          <Separator />

          <div className="flex items-start justify-between gap-6">
            <div>
              <Label htmlFor="settings-confirm">Confirm before publish</Label>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Asks once more before a post leaves through your session. The
                human approval itself is always required, with or without this.
              </p>
            </div>
            <Switch
              id="settings-confirm"
              checked={state.settings.confirmBeforePublish}
              onCheckedChange={(checked) =>
                updateState((current) => ({
                  ...current,
                  settings: {
                    ...current.settings,
                    confirmBeforePublish: checked,
                  },
                }))
              }
              data-testid="switch-confirm-publish"
            />
          </div>

          <div className="flex items-start justify-between gap-6">
            <div>
              <Label htmlFor="settings-prompts">Store AI prompts</Label>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Keeps your briefs in the local store for reuse. Off by default —
                prompts are discarded after the response.
              </p>
            </div>
            <Switch
              id="settings-prompts"
              checked={state.settings.storeAiPrompts}
              onCheckedChange={(checked) =>
                updateState((current) => ({
                  ...current,
                  settings: { ...current.settings, storeAiPrompts: checked },
                }))
              }
              data-testid="switch-store-prompts"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Local store</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <IntegrityIcon
              className={
                integrity.verified
                  ? 'h-4 w-4 text-chart-2'
                  : 'h-4 w-4 text-destructive'
              }
            />
            <span className="font-medium">
              {integrity.verified
                ? 'Append-only ledger verified'
                : 'Ledger verification failed'}
            </span>
          </div>

          <dl className="space-y-2">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Sequence</dt>
              <dd className="font-mono tabular-nums">{integrity.sequence}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Head</dt>
              <dd className="max-w-[60%] truncate font-mono text-xs">
                {integrity.head || '—'}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Last write</dt>
              <dd>{new Date(state.updatedAt).toLocaleString()}</dd>
            </div>
          </dl>

          <Separator />

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <a href="/api/browser/export" download data-testid="link-export">
                <Download className="mr-2 h-4 w-4" />
                Export state
              </a>
            </Button>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" data-testid="button-reset">
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Reset to defaults
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reset all browser state?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Workspaces, drafts, accounts, activity, usage, and your
                    approver name are cleared; UA profiles return to the
                    built-in device presets. The ledger keeps its history, so
                    the previous state remains in the export.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() =>
                      updateState(() => ({
                        ...initialState,
                        updatedAt: new Date().toISOString(),
                      }))
                    }
                    data-testid="button-confirm-reset"
                  >
                    Reset
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Boundaries</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            This browser isolates your own workspaces. It does not evade bot
            detection, solve CAPTCHAs, rotate identities to dodge rate limits,
            or automate engagement.
          </p>
          <p>
            UA profiles are declared device configurations. They are visible to
            you in the toolbar at all times, so you always know which identity a
            tab is browsing under.
          </p>
        </CardContent>
      </Card>
    </SectionShell>
  );
}
