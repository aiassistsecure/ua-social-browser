import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Copy,
  Loader2,
  Sparkles,
  Wand2,
} from 'lucide-react';
import {
  useCreateAiSuggestion,
  useListAiModels,
  type AiSuggestion,
  type AiSuggestionInputPlatform,
  type AiSuggestionInputTask,
} from '@workspace/api-client-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { SectionShell, type SectionProps } from '@/sections/section-shell';
import {
  PLATFORMS,
  PLATFORM_LABEL,
  PLATFORM_LIMIT,
  createId,
  logActivity,
} from '@/lib/workspace';
import type { Platform } from '@/types';

const TASKS: Array<{ id: AiSuggestionInputTask; label: string; hint: string }> = [
  { id: 'suggest', label: 'Suggest', hint: 'Draft new options from your notes' },
  { id: 'rewrite', label: 'Rewrite', hint: 'Keep the point, change the delivery' },
  { id: 'shorten', label: 'Shorten', hint: 'Tighten without losing meaning' },
  { id: 'expand', label: 'Expand', hint: 'Add depth and supporting detail' },
  { id: 'variants', label: 'Variants', hint: 'Same idea, different angles' },
  { id: 'hashtags', label: 'Hashtags', hint: 'Discovery tags worth using' },
];

const TONES = [
  'Direct and plainspoken',
  'Warm and conversational',
  'Analytical',
  'Optimistic',
  'Contrarian',
  'Technical',
];

export function Composer({ state, updateState, workspace }: SectionProps) {
  const { toast } = useToast();

  const [platform, setPlatform] = useState<Platform>(workspace.platform);
  const [task, setTask] = useState<AiSuggestionInputTask>('suggest');
  const [tone, setTone] = useState(TONES[0]);
  const [audience, setAudience] = useState(
    'Founders and product leaders evaluating AI tooling',
  );
  const [sourceText, setSourceText] = useState('');
  const [model, setModel] = useState(state.settings.model);
  const [count, setCount] = useState(3);
  const [includeHashtags, setIncludeHashtags] = useState(false);
  const [suggestions, setSuggestions] = useState<AiSuggestion[]>([]);
  const [reviewed, setReviewed] = useState<Record<number, boolean>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const modelsQuery = useListAiModels();
  const suggest = useCreateAiSuggestion();

  const modelOptions = useMemo(() => {
    const fetched = modelsQuery.data?.models ?? [];
    const hasConfigured = fetched.some(
      (option) => option.id === state.settings.model,
    );
    return hasConfigured
      ? fetched
      : [{ id: state.settings.model, name: state.settings.model }, ...fetched];
  }, [modelsQuery.data, state.settings.model]);

  const limit = PLATFORM_LIMIT[platform];
  const canSubmit = sourceText.trim().length >= 3 && !suggest.isPending;

  function handleGenerate() {
    if (!canSubmit) return;
    setErrorMessage(null);

    suggest.mutate(
      {
        data: {
          platform: platform as AiSuggestionInputPlatform,
          task,
          tone,
          audience,
          sourceText: sourceText.trim(),
          model,
          numberOfSuggestions: count,
          maxCharacters: limit,
          includeHashtags,
        },
      },
      {
        onSuccess: (result) => {
          setSuggestions(result.suggestions);
          setReviewed({});
          updateState((current) => ({
            ...current,
            usage: {
              inputTokens: current.usage.inputTokens + result.usage.inputTokens,
              outputTokens:
                current.usage.outputTokens + result.usage.outputTokens,
              requests: current.usage.requests + 1,
            },
            activity: logActivity(current, {
              type: 'ai',
              title: `AI ${task} generated`,
              detail: `${result.suggestions.length} ${PLATFORM_LABEL[platform]} options for ${workspace.name} · ${result.model}`,
            }),
          }));
        },
        onError: () => {
          setErrorMessage(
            'AiAssist could not generate suggestions. The request failed upstream — nothing was saved.',
          );
        },
      },
    );
  }

  function saveAsDraft(suggestion: AiSuggestion, index: number) {
    if (!reviewed[index]) {
      toast({
        title: 'Review required',
        description:
          'Confirm you have read the suggestion before it becomes a draft.',
        variant: 'destructive',
      });
      return;
    }

    updateState((current) => ({
      ...current,
      drafts: [
        {
          id: createId('draft'),
          workspaceId: workspace.id,
          platform,
          body: suggestion.text,
          media: [],
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
        title: 'Draft saved after human review',
        detail: `${PLATFORM_LABEL[platform]} · ${workspace.name}`,
      }),
    }));

    toast({
      title: 'Saved to drafts',
      description: 'You can edit, schedule, or discard it from Drafts.',
    });
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: 'Copied to clipboard' });
    } catch {
      toast({
        title: 'Clipboard unavailable',
        description: 'Select the text manually to copy it.',
        variant: 'destructive',
      });
    }
  }

  return (
    <SectionShell
      title="AI Composer"
      description="The model proposes. You decide. Every suggestion needs an explicit review before it can become a draft — nothing is queued or published automatically."
    >
      <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
        <Card className="h-fit">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Brief</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="composer-platform">Platform</Label>
              <Select
                value={platform}
                onValueChange={(value) => setPlatform(value as Platform)}
              >
                <SelectTrigger id="composer-platform" data-testid="select-platform">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {PLATFORM_LABEL[option]} · {PLATFORM_LIMIT[option]} chars
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Task</Label>
              <div className="grid grid-cols-3 gap-1.5">
                {TASKS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    title={option.hint}
                    onClick={() => setTask(option.id)}
                    className={cn(
                      'rounded-md border px-2 py-1.5 text-xs transition-colors hover-elevate',
                      task === option.id
                        ? 'border-primary bg-primary/10 font-medium text-foreground'
                        : 'border-border text-muted-foreground',
                    )}
                    data-testid={`task-${option.id}`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {TASKS.find((option) => option.id === task)?.hint}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="composer-tone">Tone</Label>
              <Select value={tone} onValueChange={setTone}>
                <SelectTrigger id="composer-tone" data-testid="select-tone">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TONES.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="composer-audience">Audience</Label>
              <Input
                id="composer-audience"
                value={audience}
                maxLength={200}
                onChange={(event) => setAudience(event.target.value)}
                data-testid="input-audience"
              />
            </div>

            <Separator />

            <div className="space-y-1.5">
              <Label htmlFor="composer-model">Model</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger id="composer-model" data-testid="select-model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {modelsQuery.isError
                  ? 'Model list unavailable — using the configured default.'
                  : `Routed server-side through provider "${state.settings.provider}".`}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="composer-count">Suggestions: {count}</Label>
              <Input
                id="composer-count"
                type="range"
                min={1}
                max={4}
                value={count}
                onChange={(event) => setCount(Number(event.target.value))}
                data-testid="input-count"
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <div>
                <Label htmlFor="composer-hashtags">Allow hashtags</Label>
                <p className="text-xs text-muted-foreground">
                  Only when they add discovery value.
                </p>
              </div>
              <Switch
                id="composer-hashtags"
                checked={includeHashtags}
                onCheckedChange={setIncludeHashtags}
                data-testid="switch-hashtags"
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Your notes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={sourceText}
                onChange={(event) => setSourceText(event.target.value)}
                placeholder="Paste a rough thought, an existing post, or the point you want to make. The model works from your material, not from scratch."
                className="min-h-[168px] resize-y"
                maxLength={12000}
                data-testid="input-source"
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground tabular-nums">
                  {sourceText.length} / 12000 · target ≤ {limit} chars for{' '}
                  {PLATFORM_LABEL[platform]}
                </span>
                <Button
                  onClick={handleGenerate}
                  disabled={!canSubmit}
                  data-testid="button-generate"
                >
                  {suggest.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Wand2 className="mr-2 h-4 w-4" />
                  )}
                  {suggest.isPending ? 'Generating' : 'Generate suggestions'}
                </Button>
              </div>

              {errorMessage ? (
                <div
                  className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                  data-testid="error-generate"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{errorMessage}</span>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {suggestions.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
                <Sparkles className="h-6 w-6 text-muted-foreground" />
                <p className="text-sm font-medium">No suggestions yet</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Write your notes and generate options. Each one arrives with a
                  rationale so you can judge it rather than trust it.
                </p>
              </CardContent>
            </Card>
          ) : (
            suggestions.map((suggestion, index) => {
              const overLimit = suggestion.characterCount > limit;
              return (
                <Card key={`${index}-${suggestion.characterCount}`} data-testid={`suggestion-${index}`}>
                  <CardContent className="space-y-3 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Option {index + 1}
                      </span>
                      <span
                        className={cn(
                          'text-xs tabular-nums',
                          overLimit
                            ? 'font-medium text-destructive'
                            : 'text-muted-foreground',
                        )}
                      >
                        {suggestion.characterCount} / {limit}
                      </span>
                    </div>

                    <p className="whitespace-pre-wrap text-sm leading-relaxed">
                      {suggestion.text}
                    </p>

                    <div className="rounded-md border border-border bg-muted/40 p-3">
                      <p className="text-xs font-medium text-muted-foreground">
                        Why the model wrote it this way
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {suggestion.rationale}
                      </p>
                    </div>

                    <Separator />

                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Switch
                          checked={Boolean(reviewed[index])}
                          onCheckedChange={(checked) =>
                            setReviewed((current) => ({
                              ...current,
                              [index]: checked,
                            }))
                          }
                          data-testid={`switch-reviewed-${index}`}
                        />
                        I read this and take responsibility for it
                      </label>

                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copyText(suggestion.text)}
                          data-testid={`button-copy-${index}`}
                        >
                          <Copy className="mr-2 h-3.5 w-3.5" />
                          Copy
                        </Button>
                        <Button
                          size="sm"
                          variant={reviewed[index] ? 'default' : 'outline'}
                          onClick={() => saveAsDraft(suggestion, index)}
                          data-testid={`button-save-draft-${index}`}
                        >
                          {reviewed[index] ? (
                            <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
                          ) : (
                            <CalendarClock className="mr-2 h-3.5 w-3.5" />
                          )}
                          Save as draft
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      </div>
    </SectionShell>
  );
}
