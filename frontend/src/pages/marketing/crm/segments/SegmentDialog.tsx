import { useEffect, useState } from 'react';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { Users, AlertCircle, RefreshCw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  Button,
  Field,
  Input,
  Textarea,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Badge,
  Callout,
} from '@/components/ui';
import { segmentMetaSchema, type SegmentMetaValues } from '../schemas';
import type { CustomFieldDef, Segment, SegmentGroup, SegmentNode, SegmentPreviewResult } from '../types';
import { isSegmentGroup, normalizeRoot } from './segmentSerialize';
import { previewSegment } from '../hooks';
import { countNodes, MAX_NODES } from '../segmentDsl';
import { PredicateBuilder } from './PredicateBuilder';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defs: CustomFieldDef[];
  segment?: Segment | null;
  onSubmit: (values: { name: string; description?: string; definition: SegmentNode }) => void;
  isPending: boolean;
}

const EMPTY_ROOT: SegmentGroup = { op: 'and', children: [] };

export function SegmentDialog({ open, onOpenChange, defs, segment, onSubmit, isPending }: Props) {
  const { t } = useTranslation('marketing');
  const isEdit = !!segment;

  const form = useForm<SegmentMetaValues>({
    resolver: zodResolver(segmentMetaSchema),
    mode: 'onBlur',
    defaultValues: { name: '', description: '' },
  });

  const [mode, setMode] = useState<'builder' | 'json'>('builder');
  const [root, setRoot] = useState<SegmentGroup>(EMPTY_ROOT);
  const [rawJson, setRawJson] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  const [preview, setPreview] = useState<SegmentPreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    form.reset({ name: segment?.name ?? '', description: segment?.description ?? '' });
    const def = segment?.definition;
    const asRoot = normalizeRoot(def);
    setRoot(asRoot);
    setRawJson(JSON.stringify(def ?? EMPTY_ROOT, null, 2));
    setMode('builder');
    setJsonError(null);
    setPreview(null);
    setPreviewError(null);
  }, [segment, open, form]);

  /** Resolve the active definition (builder tree or parsed JSON). */
  const currentDefinition = (): SegmentNode | null => {
    if (mode === 'json') {
      try {
        const parsed = JSON.parse(rawJson) as SegmentNode;
        setJsonError(null);
        return parsed;
      } catch (e) {
        setJsonError((e as Error).message);
        return null;
      }
    }
    return root;
  };

  const nodeCount = countNodes(root);
  const overLimit = nodeCount > MAX_NODES;

  const runPreview = async () => {
    const def = currentDefinition();
    if (!def) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const res = await previewSegment(def);
      setPreview(res);
    } catch (e) {
      const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data
        ?.message;
      setPreviewError(Array.isArray(msg) ? msg[0] : (msg ?? 'Preview failed'));
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleSubmit: SubmitHandler<SegmentMetaValues> = (values) => {
    const def = currentDefinition();
    if (!def) return;
    onSubmit({
      name: values.name,
      // Send description explicitly (empty when blanked) so an EDIT can actually
      // clear it — omitting it left the old value on the partial-update PATCH.
      // Harmless on create (nullable column).
      description: values.description ?? '',
      definition: def,
    });
  };

  const fieldErr = (msg?: string) =>
    msg ? t([`validation.${msg}`, msg], { defaultValue: msg }) : undefined;
  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('crm.seg.editTitle', { defaultValue: 'Edit segment' })
              : t('crm.seg.createTitle', { defaultValue: 'New segment' })}
          </DialogTitle>
          <DialogDescription>
            {t('crm.seg.dialogDesc', {
              defaultValue: 'Segments are saved, live filters over your leads.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('crm.seg.name', { defaultValue: 'Name' })} error={fieldErr(errors.name?.message)} required>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder={t('crm.seg.namePlaceholder', { defaultValue: 'e.g. Hot leads in Istanbul' })}
                  {...form.register('name')}
                />
              )}
            </Field>
            <Field label={t('crm.seg.description', { defaultValue: 'Description' })} error={fieldErr(errors.description?.message)}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder={t('crm.seg.descPlaceholder', { defaultValue: 'Optional' })}
                  {...form.register('description')}
                />
              )}
            </Field>
          </div>

          <Tabs value={mode} onValueChange={(v) => setMode(v as 'builder' | 'json')}>
            <div className="flex items-center justify-between">
              <TabsList>
                <TabsTrigger value="builder">{t('crm.seg.builderTab', { defaultValue: 'Builder' })}</TabsTrigger>
                <TabsTrigger value="json">{t('crm.seg.jsonTab', { defaultValue: 'Raw JSON' })}</TabsTrigger>
              </TabsList>
              {mode === 'builder' && (
                <Badge tone={overLimit ? 'danger' : 'neutral'} size="sm">
                  {nodeCount}/{MAX_NODES} {t('crm.seg.rules', { defaultValue: 'rules' })}
                </Badge>
              )}
            </div>

            <TabsContent value="builder" className="pt-3">
              <PredicateBuilder
                defs={defs}
                value={root}
                onChange={(g) => {
                  setRoot(g);
                  // keep the JSON view in sync
                  setRawJson(JSON.stringify(g, null, 2));
                }}
              />
            </TabsContent>

            <TabsContent value="json" className="pt-3">
              <Field
                label={t('crm.seg.jsonLabel', { defaultValue: 'Predicate JSON' })}
                error={jsonError ?? undefined}
                hint={t('crm.seg.jsonHint', {
                  defaultValue: 'Escape hatch for advanced predicates. Shape: { op, children } or { field, cmp, value }.',
                })}
              >
                {({ id, describedBy, invalid }) => (
                  <Textarea
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    rows={10}
                    className="font-mono text-xs"
                    value={rawJson}
                    onChange={(e) => {
                      setRawJson(e.target.value);
                      try {
                        const parsed = JSON.parse(e.target.value) as SegmentNode;
                        setJsonError(null);
                        if (isSegmentGroup(parsed)) setRoot(parsed);
                      } catch {
                        // surfaced lazily on preview/submit
                      }
                    }}
                  />
                )}
              </Field>
            </TabsContent>
          </Tabs>

          {/* Live preview */}
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                {t('crm.seg.matchPreview', { defaultValue: 'Matching leads' })}
                {preview && (
                  <Badge tone="primary" size="sm">
                    {preview.count}
                  </Badge>
                )}
              </div>
              <Button type="button" variant="outline" size="sm" loading={previewLoading} onClick={runPreview}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                {t('crm.seg.preview', { defaultValue: 'Preview' })}
              </Button>
            </div>
            {previewError && (
              <Callout tone="danger" className="mt-2">
                <span className="flex items-center gap-1.5">
                  <AlertCircle className="h-4 w-4" aria-hidden="true" />
                  {previewError}
                </span>
              </Callout>
            )}
            {preview && preview.sample.length > 0 && (
              <ul className="mt-2 space-y-1">
                {preview.sample.map((l) => (
                  <li key={l.id} className="flex items-center justify-between text-xs text-muted-foreground">
                    <span className="text-foreground">{l.businessName ?? l.contactPerson ?? l.id}</span>
                    <span>{[l.city, l.status].filter(Boolean).join(' · ')}</span>
                  </li>
                ))}
              </ul>
            )}
            {preview && preview.count === 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('crm.seg.noMatches', { defaultValue: 'No leads match this segment yet.' })}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending} disabled={overLimit || (mode === 'json' && !!jsonError)}>
              {isEdit ? t('common.save', { defaultValue: 'Save' }) : t('crm.seg.createTitle', { defaultValue: 'New segment' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
