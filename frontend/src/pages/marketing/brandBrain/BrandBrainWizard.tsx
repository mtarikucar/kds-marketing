import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Sparkles, X } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Field,
  Input,
  Textarea,
  Button,
  IconButton,
  Badge,
  Callout,
  Spinner,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui';
import { useBrandAnalysis } from '../../../features/marketing/hooks/useBrandAnalysis';
import type { BrandAnalysisDraft } from '../../../features/marketing/api/brandBrain.service';

type Network = 'INSTAGRAM' | 'FACEBOOK' | 'LINKEDIN';
const NETWORKS: Array<{ value: Network; label: string }> = [
  { value: 'INSTAGRAM', label: 'Instagram' },
  { value: 'FACEBOOK', label: 'Facebook' },
  { value: 'LINKEDIN', label: 'LinkedIn' },
];

// Client-side escape: if polling never reaches a terminal status (e.g. a
// crashed backend run somehow never resolves, or the poll itself is stuck),
// stop showing an endless spinner and surface the failure branch instead (F1).
export const ANALYZE_TIMEOUT_MS = 15 * 60 * 1000; // 15 min — genuine hangs only; the backend reaper is the authoritative 45min cleanup

// One list item per line in the textarea — same idiom as BrandProfileEditor
// (no dependency on a chip/tag input).
const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * First-login Brand Brain setup wizard (Faz 3) — sources → analyzing → review
 * → apply, an inline state-toggle self-contained flow (no router changes).
 * Manager enters a few sources, the native research agent drafts a brand
 * profile + targeting + starter knowledge base, and nothing goes live until
 * the manager reviews and applies it.
 *
 * Scope deferrals (kept out on purpose to stay self-contained):
 *  - Social handles are entered manually; prefill from connected social
 *    accounts is deferred (no clean FE accounts API yet).
 *  - File uploads are deferred (no key-returning upload endpoint wired) — the
 *    sources form never collects `uploadKeys`.
 */
export default function BrandBrainWizard({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation('marketing');
  const { start, apply, run, runId, reset } = useBrandAnalysis();

  // sources form state
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [gbpQuery, setGbpQuery] = useState('');
  const [handles, setHandles] = useState<Array<{ network: Network; handle: string }>>([]);

  // editable review copy (initialized once the draft arrives)
  const [edit, setEdit] = useState<{ brandName: string; description: string; valueProps: string; toneWords: string } | null>(
    null,
  );

  // Client-side escape hatch (F1): if analyzing runs longer than
  // ANALYZE_TIMEOUT_MS without reaching a terminal status, stop polling
  // silently forever and show the failure surface instead.
  const [timedOut, setTimedOut] = useState(false);

  const status = run.data?.status;
  const step: 'sources' | 'analyzing' | 'review' | 'done' = !runId
    ? 'sources'
    : status === 'READY_FOR_REVIEW'
      ? 'review'
      : status === 'APPLIED'
        ? 'done'
        : 'analyzing'; // QUEUED/RUNNING/undefined/FAILED handled inside

  useEffect(() => {
    if (step !== 'analyzing' || run.data?.status === 'FAILED') {
      setTimedOut(false);
      return;
    }
    const t = setTimeout(() => setTimedOut(true), ANALYZE_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [step, run.data?.status]);

  // Seed the editable copy once the draft is ready.
  useEffect(() => {
    if (status === 'READY_FOR_REVIEW' && run.data?.draft && !edit) {
      const p = run.data.draft.profile ?? {};
      setEdit({
        brandName: p.brandName ?? '',
        description: p.description ?? '',
        valueProps: (p.valueProps ?? []).join('\n'),
        toneWords: (p.toneWords ?? []).join('\n'),
      });
    }
  }, [status, run.data, edit]);

  const addHandle = () => setHandles((h) => [...h, { network: 'INSTAGRAM', handle: '' }]);
  const updateHandle = (i: number, patch: Partial<{ network: Network; handle: string }>) =>
    setHandles((h) => h.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  const removeHandle = (i: number) => setHandles((h) => h.filter((_, idx) => idx !== i));

  const hasSource = !!websiteUrl.trim() || !!gbpQuery.trim() || handles.some((h) => h.handle.trim());

  const submitSources = () =>
    start.mutate({
      websiteUrl: websiteUrl.trim() || undefined,
      gbpQuery: gbpQuery.trim() || undefined,
      socialHandles: handles.filter((h) => h.handle.trim()),
    });

  const submitApply = () => {
    if (!runId || !run.data?.draft || !edit) return;
    const draft: BrandAnalysisDraft = {
      ...run.data.draft, // preserve researchProfile, brandKitHints, knowledgeDocs, offerings, etc. (G4)
      profile: {
        ...run.data.draft.profile,
        brandName: edit.brandName || undefined,
        description: edit.description || undefined,
        valueProps: lines(edit.valueProps),
        toneWords: lines(edit.toneWords),
      },
    };
    apply.mutate(
      { runId, draft },
      {
        onSuccess: () => toast.success(t('brand.wizard.applied', 'Brand Brain set up — every AI now speaks your brand')),
        onError: (e: any) => toast.error(e?.response?.data?.message ?? t('brand.wizard.applyFailed', 'Apply failed')),
      },
    );
  };

  if (step === 'sources') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('brand.wizard.title', 'Set up your Brand Brain with AI')}</CardTitle>
          <CardDescription>
            {t(
              'brand.wizard.subtitle',
              'Give us a few sources and we’ll draft your brand profile, targeting and a starter knowledge base — nothing goes live until you review it.',
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field label={t('brand.wizard.websiteUrl', 'Website URL')}>
            {({ id }) => (
              <Input
                id={id}
                placeholder="https://your-brand.com"
                value={websiteUrl}
                onChange={(e) => setWebsiteUrl(e.target.value)}
              />
            )}
          </Field>

          <Field label={t('brand.wizard.gbpQuery', 'Google Business name or URL')}>
            {({ id }) => (
              <Input
                id={id}
                placeholder="Acme Dental Istanbul"
                value={gbpQuery}
                onChange={(e) => setGbpQuery(e.target.value)}
              />
            )}
          </Field>

          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">{t('brand.wizard.socialHandles', 'Social accounts')}</p>
            {handles.map((h, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select value={h.network} onValueChange={(v) => updateHandle(i, { network: v as Network })}>
                  <SelectTrigger className="w-36" aria-label={t('brand.wizard.network', 'Network')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {NETWORKS.map((n) => (
                      <SelectItem key={n.value} value={n.value}>
                        {n.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  className="flex-1"
                  placeholder="@acme"
                  aria-label={t('brand.wizard.handle', 'Handle')}
                  value={h.handle}
                  onChange={(e) => updateHandle(i, { handle: e.target.value })}
                />
                <IconButton
                  aria-label={t('common.remove', 'Remove')}
                  onClick={() => removeHandle(i)}
                >
                  <X className="h-4 w-4" />
                </IconButton>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={addHandle}>
              {t('brand.wizard.addAccount', 'Add account')}
            </Button>
          </div>

          <Callout tone="info">
            {t(
              'brand.wizard.deferredNote',
              'File uploads and prefilling from your connected social accounts are coming soon — for now, paste the handles you want us to read.',
            )}
          </Callout>
        </CardContent>
        <CardFooter className="justify-end gap-2 border-t border-border pt-4">
          <Button variant="ghost" onClick={onDone}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button onClick={submitSources} disabled={start.isPending || !hasSource} loading={start.isPending}>
            <Sparkles className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {t('brand.wizard.analyze', 'Analyze')}
          </Button>
        </CardFooter>
      </Card>
    );
  }

  if (step === 'analyzing') {
    if (status === 'FAILED' || timedOut) {
      return (
        <Card>
          <CardHeader>
            <CardTitle>{t('brand.wizard.title', 'Set up your Brand Brain with AI')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Callout tone="danger" title={t('brand.wizard.failedTitle', 'Analysis failed')}>
              {timedOut
                ? t('brand.wizard.timedOut', 'This is taking longer than expected. Please try again.')
                : (run.data?.error ?? t('brand.wizard.failedDesc', 'Something went wrong while analyzing your sources.'))}
            </Callout>
          </CardContent>
          <CardFooter className="justify-end border-t border-border pt-4">
            <Button
              variant="secondary"
              onClick={() => {
                setTimedOut(false);
                reset();
              }}
            >
              {t('brand.wizard.startOver', 'Start over')}
            </Button>
          </CardFooter>
        </Card>
      );
    }
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <Spinner className="h-6 w-6 text-primary" />
          <p className="text-sm text-muted-foreground">
            {t('brand.wizard.analyzing', 'Analyzing your brand across your sources…')}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (step === 'review') {
    const draft = run.data?.draft;
    const rp = draft?.researchProfile;
    const kit = draft?.brandKitHints;
    const docCount = draft?.knowledgeDocs?.length ?? 0;

    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('brand.wizard.reviewTitle', 'Review your Brand Brain')}</CardTitle>
          <CardDescription>
            {t('brand.wizard.reviewSubtitle', 'We drafted this from your sources — edit anything before it goes live.')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field label={t('brand.wizard.brandName', 'Brand name')}>
            {({ id }) => (
              <Input
                id={id}
                value={edit?.brandName ?? ''}
                onChange={(e) => setEdit((s) => (s ? { ...s, brandName: e.target.value } : s))}
              />
            )}
          </Field>

          <Field label={t('brand.wizard.description', 'Description')}>
            {({ id }) => (
              <Textarea
                id={id}
                rows={3}
                value={edit?.description ?? ''}
                onChange={(e) => setEdit((s) => (s ? { ...s, description: e.target.value } : s))}
              />
            )}
          </Field>

          <Field
            label={t('brand.wizard.valueProps', 'Value propositions')}
            hint={t('brand.brain.editor.oneItemPerLine', 'One item per line.')}
          >
            {({ id }) => (
              <Textarea
                id={id}
                rows={3}
                value={edit?.valueProps ?? ''}
                onChange={(e) => setEdit((s) => (s ? { ...s, valueProps: e.target.value } : s))}
              />
            )}
          </Field>

          <Field
            label={t('brand.wizard.toneWords', 'Tone words')}
            hint={t('brand.brain.editor.oneItemPerLine', 'One item per line.')}
          >
            {({ id }) => (
              <Textarea
                id={id}
                rows={3}
                value={edit?.toneWords ?? ''}
                onChange={(e) => setEdit((s) => (s ? { ...s, toneWords: e.target.value } : s))}
              />
            )}
          </Field>

          <div className="space-y-2 rounded-lg border border-border p-3.5">
            <p className="text-sm font-medium text-foreground">{t('brand.wizard.proposedTargeting', 'Proposed targeting')}</p>
            {rp?.businessTypes && rp.businessTypes.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {rp.businessTypes.map((bt) => (
                  <Badge key={bt} tone="primary">
                    {bt}
                  </Badge>
                ))}
              </div>
            )}
            {rp?.icpDescription && <p className="text-sm text-muted-foreground">{rp.icpDescription}</p>}
            {kit?.tone && (
              <p className="text-sm text-muted-foreground">
                {t('brand.wizard.brandKitTone', 'Tone: {{tone}}', { tone: kit.tone })}
              </p>
            )}
            {kit?.cta && (
              <p className="text-sm text-muted-foreground">
                {t('brand.wizard.brandKitCta', 'CTA: {{cta}}', { cta: kit.cta })}
              </p>
            )}
            {kit?.hashtags && kit.hashtags.length > 0 && (
              <p className="text-sm text-muted-foreground">{kit.hashtags.join(' ')}</p>
            )}
            <p className="text-sm text-muted-foreground">
              {t('brand.wizard.knowledgeDocsCount', '{{n}} knowledge docs will be added', { n: docCount })}
            </p>
          </div>
        </CardContent>
        <CardFooter className="items-center justify-between gap-2 border-t border-border pt-4">
          <p className="text-caption text-muted-foreground">
            {t('brand.wizard.editLater', 'You can fine-tune everything again later from Brand Brain.')}
          </p>
          <Button onClick={submitApply} disabled={apply.isPending} loading={apply.isPending}>
            {t('brand.wizard.applyActivate', 'Apply & activate')}
          </Button>
        </CardFooter>
      </Card>
    );
  }

  // step === 'done'
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
        <Sparkles className="h-8 w-8 text-primary" aria-hidden="true" />
        <p className="text-base font-medium text-foreground">{t('brand.wizard.doneTitle', 'Your Brand Brain is live')}</p>
        <p className="text-sm text-muted-foreground">
          {t('brand.wizard.doneDesc', 'Every AI in the workspace now speaks your brand — conversations, content, social and voice.')}
        </p>
      </CardContent>
      <CardFooter className="justify-center border-t border-border pt-4">
        <Button onClick={onDone}>{t('brand.wizard.finish', 'Finish')}</Button>
      </CardFooter>
    </Card>
  );
}
