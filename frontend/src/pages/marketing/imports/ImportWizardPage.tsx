/**
 * CSV Lead-Import Wizard
 *
 * Steps:
 *   1. Upload  — file input; read CSV client-side; POST /imports → get headers + suggestedMapping
 *   2. Map     — one row per CSV header; Select to target field; shows sample values
 *   3. Options — dedupe policy (SKIP / UPDATE / CREATE)
 *   4. Progress — POST /imports/:id/commit → poll GET /imports/:id every 2 s until DONE/FAILED
 *
 * Past imports list at the bottom via GET /imports.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Upload,
  FileText,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';

import {
  PageHeader,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Badge,
  Progress,
  Callout,
  Spinner,
  DataTable,
  EmptyState,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Skeleton,
} from '@/components/ui';

import {
  useImportList,
  useImportJob,
  useUploadImport,
  useCommitImport,
  importListKey,
  type ImportJob,
  type ImportDedupePolicy,
  type UploadResult,
} from './importsApi';
import { buildSampleRows } from './csv-preview';

// ── Native fields the backend accepts + special values ───────────────────────

const NATIVE_FIELDS = [
  'businessName',
  'contactPerson',
  'phone',
  'whatsapp',
  'email',
  'address',
  'city',
  'region',
  'businessType',
  'currentSystem',
  'source',
  'notes',
  'priority',
  'tags',
] as const;

const FIELD_OPTIONS = [
  { value: '__skip', label: '— skip —' },
  ...NATIVE_FIELDS.map((f) => ({ value: f, label: f })),
];

// ── Step indicator ────────────────────────────────────────────────────────────

const STEPS = ['upload', 'map', 'options', 'progress'] as const;
type WizardStep = (typeof STEPS)[number];

function StepIndicator({ current }: { current: WizardStep }) {
  const labels: Record<WizardStep, string> = {
    upload: 'Upload',
    map: 'Map columns',
    options: 'Options',
    progress: 'Progress',
  };
  const idx = STEPS.indexOf(current);
  return (
    <ol className="flex items-center gap-0">
      {STEPS.map((step, i) => {
        const done = i < idx;
        const active = i === idx;
        return (
          <li key={step} className="flex items-center">
            <span
              className={[
                'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors',
                done ? 'bg-success text-white' : active ? 'bg-primary text-white' : 'bg-surface-muted text-muted-foreground',
              ].join(' ')}
            >
              {done ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
            </span>
            <span
              className={[
                'ml-2 text-sm font-medium',
                active ? 'text-foreground' : done ? 'text-muted-foreground' : 'text-muted-foreground',
              ].join(' ')}
            >
              {labels[step]}
            </span>
            {i < STEPS.length - 1 && (
              <span className="mx-3 h-px w-8 bg-border flex-shrink-0" aria-hidden="true" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ── Step 1: Upload ────────────────────────────────────────────────────────────

interface UploadStepProps {
  onDone: (result: UploadResult, sampleRows: Record<string, string>[]) => void;
}

function UploadStep({ onDone }: UploadStepProps) {
  const { t } = useTranslation('marketing');
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadImport();
  const [dragOver, setDragOver] = useState(false);

  const processFile = useCallback(
    (file: File) => {
      if (!file.name.endsWith('.csv') && file.type !== 'text/csv') {
        toast.error(t('import.errorNotCsv', { defaultValue: 'Please select a CSV file.' }));
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        upload.mutate(
          { filename: file.name, content },
          {
            onSuccess: (result) => {
              // Quote-aware preview parse keyed by the backend's own headers, so
              // the "Sample values" shown line up with what the backend actually
              // reads (a naive split(',') shifts columns after a quoted comma).
              const sampleRows = buildSampleRows(content, result.headers);
              onDone(result, sampleRows);
            },
            onError: (err: unknown) => {
              const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
              toast.error(msg ?? t('import.uploadError', { defaultValue: 'Upload failed.' }));
            },
          },
        );
      };
      reader.readAsText(file, 'utf-8');
    },
    [upload, onDone, t],
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('import.uploadHint', {
          defaultValue:
            'Upload a CSV file (up to 50,000 rows). The first row must be a header row.',
        })}
      </p>

      <button
        type="button"
        aria-label={t('import.selectFile', { defaultValue: 'Select CSV file' })}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files[0];
          if (file) processFile(file);
        }}
        className={[
          'flex w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-10 transition-colors',
          dragOver
            ? 'border-primary bg-primary/5'
            : 'border-border bg-surface-muted hover:border-primary/50 hover:bg-surface',
        ].join(' ')}
      >
        {upload.isPending ? (
          <Spinner className="h-8 w-8 text-primary" />
        ) : (
          <Upload className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="text-sm font-medium text-foreground">
          {upload.isPending
            ? t('import.uploading', { defaultValue: 'Uploading…' })
            : t('import.dropOrClick', { defaultValue: 'Drop a CSV here, or click to browse' })}
        </span>
        <span className="text-xs text-muted-foreground">
          {t('import.maxRows', { defaultValue: 'Max 50,000 rows · UTF-8 · first row = headers' })}
        </span>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) processFile(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}

// ── Step 2: Map columns ───────────────────────────────────────────────────────

interface MapStepProps {
  headers: string[];
  mapping: Record<string, string>;
  onMappingChange: (mapping: Record<string, string>) => void;
  sampleRows: Record<string, string>[];
  onBack: () => void;
  onNext: () => void;
}

function MapStep({ headers, mapping, onMappingChange, sampleRows, onBack, onNext }: MapStepProps) {
  const { t } = useTranslation('marketing');

  // businessName is the one hard-required native field — the backend rejects
  // EVERY row without it. The auto-mapping synonyms are English-only, so a
  // Turkish header (e.g. "Firma Adı") arrives unmapped; without this guard the
  // user could run a silently 100%-failed import. Block Next until it's mapped.
  const hasBusinessName = Object.values(mapping).includes('businessName');

  // Two columns mapped to the SAME native field silently drop one on import: the
  // backend's buildLeadData assigns per field, so the LAST header mapped wins for
  // every row and the other column's data vanishes. Block Next until resolved.
  // '__skip' may repeat freely; 'tags' legitimately merges multiple columns.
  const duplicateFields = useMemo(() => {
    const counts = new Map<string, number>();
    for (const field of Object.values(mapping)) {
      if (field === '__skip' || field === 'tags') continue;
      counts.set(field, (counts.get(field) ?? 0) + 1);
    }
    return [...counts.entries()].filter(([, n]) => n > 1).map(([field]) => field);
  }, [mapping]);
  const duplicateLabels = duplicateFields
    .map((f) => FIELD_OPTIONS.find((o) => o.value === f)?.label ?? f)
    .join(', ');

  const setField = (header: string, field: string) => {
    onMappingChange({ ...mapping, [header]: field });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('import.mapHint', {
          defaultValue:
            'Map each CSV column to a lead field. Columns mapped to "— skip —" will be ignored.',
        })}
      </p>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-muted">
              <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">
                {t('import.csvColumn', { defaultValue: 'CSV column' })}
              </th>
              <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">
                {t('import.sampleValues', { defaultValue: 'Sample values' })}
              </th>
              <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">
                {t('import.mapsTo', { defaultValue: 'Maps to' })}
              </th>
            </tr>
          </thead>
          <tbody>
            {headers.map((header) => (
              <tr key={header} className="border-b border-border last:border-0">
                <td className="px-3 py-2 font-mono text-xs font-medium text-foreground">
                  {header}
                </td>
                <td className="max-w-[200px] truncate px-3 py-2 text-xs text-muted-foreground">
                  {sampleRows
                    .map((r) => r[header])
                    .filter(Boolean)
                    .slice(0, 3)
                    .join(', ') || '—'}
                </td>
                <td className="px-3 py-2">
                  <Select
                    value={mapping[header] ?? '__skip'}
                    onValueChange={(v) => setField(header, v)}
                  >
                    <SelectTrigger className="h-8 w-48 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELD_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value} className="text-xs">
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!hasBusinessName && (
        <Callout tone="warning" icon={<AlertCircle className="h-4 w-4" />}>
          {t('import.businessNameRequired', {
            defaultValue:
              'Map a CSV column to “businessName” — it is required for every lead.',
          })}
        </Callout>
      )}

      {duplicateFields.length > 0 && (
        <Callout tone="warning" icon={<AlertCircle className="h-4 w-4" />}>
          {t('import.duplicateFields', {
            defaultValue:
              'More than one column is mapped to the same field ({{fields}}). Only one would be imported — map each field once.',
            fields: duplicateLabels,
          })}
        </Callout>
      )}

      <div className="flex gap-3 pt-2">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {t('common.back', { defaultValue: 'Back' })}
        </Button>
        <Button onClick={onNext} disabled={!hasBusinessName || duplicateFields.length > 0}>
          {t('common.next', { defaultValue: 'Next' })}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

// ── Step 3: Options (dedupe) ──────────────────────────────────────────────────

interface OptionsStepProps {
  dedupePolicy: ImportDedupePolicy;
  onPolicyChange: (p: ImportDedupePolicy) => void;
  onBack: () => void;
  onCommit: () => void;
  isCommitting: boolean;
}

const DEDUPE_OPTIONS: { value: ImportDedupePolicy; label: string; description: string }[] = [
  {
    value: 'SKIP',
    label: 'Skip duplicates',
    description: 'Keep existing leads unchanged; skip CSV rows that match an existing email or phone.',
  },
  {
    value: 'UPDATE',
    label: 'Update duplicates',
    description: 'Overwrite matching leads with the CSV values; create new leads for unmatched rows.',
  },
  {
    value: 'CREATE',
    label: 'Always create',
    description: 'Create a new lead for every CSV row, even if a duplicate exists.',
  },
];

function OptionsStep({
  dedupePolicy,
  onPolicyChange,
  onBack,
  onCommit,
  isCommitting,
}: OptionsStepProps) {
  const { t } = useTranslation('marketing');

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('import.optionsHint', {
          defaultValue:
            'Choose how to handle CSV rows where the email or phone already exists in your leads.',
        })}
      </p>

      <div className="space-y-3">
        {DEDUPE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onPolicyChange(opt.value)}
            className={[
              'flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors',
              dedupePolicy === opt.value
                ? 'border-primary bg-primary/5'
                : 'border-border bg-surface hover:border-primary/40',
            ].join(' ')}
          >
            <span
              className={[
                'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2',
                dedupePolicy === opt.value
                  ? 'border-primary bg-primary'
                  : 'border-muted-foreground',
              ].join(' ')}
            >
              {dedupePolicy === opt.value && (
                <span className="h-1.5 w-1.5 rounded-full bg-white" />
              )}
            </span>
            <div>
              <p className="text-sm font-medium text-foreground">{opt.label}</p>
              <p className="text-xs text-muted-foreground">{opt.description}</p>
            </div>
          </button>
        ))}
      </div>

      <div className="flex gap-3 pt-2">
        <Button variant="outline" onClick={onBack} disabled={isCommitting}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {t('common.back', { defaultValue: 'Back' })}
        </Button>
        <Button onClick={onCommit} loading={isCommitting}>
          {t('import.startImport', { defaultValue: 'Start import' })}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

// ── Step 4: Progress polling ──────────────────────────────────────────────────

interface ProgressStepProps {
  jobId: string;
  onStartNew: () => void;
}

function ProgressStep({ jobId, onStartNew }: ProgressStepProps) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const { data: job } = useImportJob(jobId, true);

  // The polled job surfaces completion, but the "Import history" list below was
  // fetched at commit time (job RUNNING, processed 0) and nothing else refreshes
  // it — invalidate it once the job reaches a terminal status so the history row
  // shows the final counts/status instead of the frozen RUNNING snapshot.
  const jobStatus = job?.status;
  useEffect(() => {
    if (jobStatus === 'DONE' || jobStatus === 'FAILED') {
      qc.invalidateQueries({ queryKey: importListKey() });
    }
  }, [jobStatus, qc]);

  if (!job) {
    return (
      <div className="flex items-center gap-3 py-8">
        <Spinner className="h-5 w-5 text-primary" />
        <span className="text-sm text-muted-foreground">
          {t('import.starting', { defaultValue: 'Starting import…' })}
        </span>
      </div>
    );
  }

  const isDone = job.status === 'DONE';
  const isFailed = job.status === 'FAILED';
  const isRunning = job.status === 'RUNNING';
  const pct = job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;

  return (
    <div className="space-y-5">
      {/* Status banner */}
      {isDone && (
        <Callout tone="success" icon={<CheckCircle2 className="h-4 w-4" />}
          title={t('import.done', { defaultValue: 'Import complete' })}>
          {t('import.doneDesc', {
            defaultValue: `Processed all ${job.total} rows.`,
            total: job.total,
          })}
        </Callout>
      )}
      {isFailed && (
        <Callout tone="danger" icon={<AlertCircle className="h-4 w-4" />}
          title={t('import.failed', { defaultValue: 'Import failed' })}>
          {t('import.failedDesc', {
            defaultValue: 'The import job encountered a fatal error. Try again.',
          })}
        </Callout>
      )}
      {isRunning && (
        <Callout tone="info" icon={<RefreshCw className="h-4 w-4 animate-spin" />}
          title={t('import.running', { defaultValue: 'Import running…' })}>
          {t('import.runningDesc', {
            defaultValue: `Processing batch — ${job.processed} of ${job.total} rows processed.`,
            processed: job.processed,
            total: job.total,
          })}
        </Callout>
      )}

      {/* Progress bar */}
      {(isRunning || isDone) && (
        <div className="space-y-1.5">
          <Progress
            value={pct}
            tone={isDone ? 'success' : 'primary'}
          />
          <p className="text-xs text-right text-muted-foreground">
            {pct}% ({job.processed} / {job.total})
          </p>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(
          [
            { label: t('import.created', { defaultValue: 'Created' }), value: job.created, tone: 'success' },
            { label: t('import.updated', { defaultValue: 'Updated' }), value: job.updated, tone: 'info' },
            { label: t('import.skipped', { defaultValue: 'Skipped' }), value: job.skipped, tone: 'neutral' },
            { label: t('import.errors', { defaultValue: 'Errors' }), value: job.failed, tone: job.failed > 0 ? 'danger' : 'neutral' },
          ] as const
        ).map(({ label, value, tone }) => (
          <div key={label} className="rounded-lg border border-border bg-surface p-3 text-center">
            <p className="text-2xl font-bold text-foreground">{value}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
            {value > 0 && tone !== 'neutral' && (
              <Badge tone={tone} size="sm" className="mt-1">
                {tone}
              </Badge>
            )}
          </div>
        ))}
      </div>

      {/* Error sample */}
      {job.errors && job.errors.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">
            {t('import.errorSample', { defaultValue: 'Error sample (first 50)' })}
          </p>
          <div className="max-h-40 overflow-y-auto rounded-lg border border-border bg-surface-muted p-3">
            {job.errors.map((err, i) => (
              <p key={i} className="font-mono text-xs text-danger">
                Row {err.row + 1}: {err.message}
              </p>
            ))}
          </div>
        </div>
      )}

      {(isDone || isFailed) && (
        <Button variant="outline" onClick={onStartNew}>
          <Upload className="h-4 w-4" aria-hidden="true" />
          {t('import.importAnother', { defaultValue: 'Import another file' })}
        </Button>
      )}
    </div>
  );
}

// ── Past imports list ─────────────────────────────────────────────────────────

function statusBadge(status: string) {
  if (status === 'DONE') return <Badge tone="success" size="sm">Done</Badge>;
  if (status === 'RUNNING') return <Badge tone="info" size="sm">Running</Badge>;
  if (status === 'MAPPING') return <Badge tone="warning" size="sm">Mapping</Badge>;
  if (status === 'FAILED') return <Badge tone="danger" size="sm">Failed</Badge>;
  return <Badge size="sm">{status}</Badge>;
}

function PastImportsList() {
  const { t } = useTranslation('marketing');
  const { data, isLoading } = useImportList();

  const columns: ColumnDef<ImportJob, unknown>[] = [
    {
      accessorKey: 'filename',
      header: t('import.colFile', { defaultValue: 'File' }),
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="text-sm font-medium text-foreground">{row.original.filename}</span>
        </div>
      ),
    },
    {
      accessorKey: 'status',
      header: t('import.colStatus', { defaultValue: 'Status' }),
      cell: ({ getValue }) => statusBadge(getValue<string>()),
    },
    {
      accessorKey: 'total',
      header: t('import.colTotal', { defaultValue: 'Rows' }),
      cell: ({ getValue }) => (
        <span className="text-sm text-foreground">{getValue<number>().toLocaleString()}</span>
      ),
    },
    {
      id: 'results',
      header: t('import.colResults', { defaultValue: 'Results' }),
      cell: ({ row }) => {
        const j = row.original;
        if (j.status !== 'DONE' && j.status !== 'RUNNING') return <span className="text-muted-foreground">—</span>;
        return (
          <span className="text-xs text-muted-foreground">
            +{j.created} / ~{j.updated} / ={j.skipped}
            {j.failed > 0 && <span className="ml-1 text-danger">{j.failed} err</span>}
          </span>
        );
      },
    },
    {
      accessorKey: 'createdAt',
      header: t('import.colDate', { defaultValue: 'Date' }),
      cell: ({ getValue }) => (
        <span className="text-xs text-muted-foreground">
          {new Date(getValue<string>()).toLocaleDateString()}
        </span>
      ),
    },
  ];

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[...Array(3)].map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  return (
    <DataTable
      columns={columns}
      data={data ?? []}
      isLoading={isLoading}
      loadingRowCount={3}
      emptyState={
        <EmptyState
          icon={<FileText className="h-8 w-8" />}
          title={t('import.noHistory', { defaultValue: 'No past imports' })}
          description={t('import.noHistoryHint', {
            defaultValue: 'Your import history will appear here.',
          })}
        />
      }
    />
  );
}

// ── Main wizard page ──────────────────────────────────────────────────────────

export default function ImportWizardPage() {
  const { t } = useTranslation('marketing');

  const [step, setStep] = useState<WizardStep>('upload');

  // Upload result
  const [jobId, setJobId] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [sampleRows, setSampleRows] = useState<Record<string, string>[]>([]);
  const [dedupePolicy, setDedupePolicy] = useState<ImportDedupePolicy>('SKIP');

  const commit = useCommitImport();

  const handleUploadDone = (result: UploadResult, samples: Record<string, string>[]) => {
    setJobId(result.jobId);
    setHeaders(result.headers);
    setMapping(result.suggestedMapping);
    setSampleRows(samples);
    setStep('map');
  };

  const handleCommit = () => {
    if (!jobId) return;
    commit.mutate(
      { jobId, mapping, dedupePolicy },
      {
        onSuccess: () => setStep('progress'),
        onError: (err: unknown) => {
          const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
          toast.error(msg ?? t('import.commitError', { defaultValue: 'Failed to start import.' }));
        },
      },
    );
  };

  const reset = () => {
    setStep('upload');
    setJobId(null);
    setHeaders([]);
    setMapping({});
    setSampleRows([]);
    setDedupePolicy('SKIP');
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('import.title', { defaultValue: 'Import leads' })}
        description={t('import.subtitle', {
          defaultValue: 'Upload a CSV file to bulk-import leads into your workspace.',
        })}
      />

      {/* Wizard card */}
      <Card>
        <CardHeader>
          <StepIndicator current={step} />
        </CardHeader>
        <CardContent className="pt-0">
          {step === 'upload' && <UploadStep onDone={handleUploadDone} />}
          {step === 'map' && (
            <MapStep
              headers={headers}
              mapping={mapping}
              onMappingChange={setMapping}
              sampleRows={sampleRows}
              onBack={() => setStep('upload')}
              onNext={() => setStep('options')}
            />
          )}
          {step === 'options' && (
            <OptionsStep
              dedupePolicy={dedupePolicy}
              onPolicyChange={setDedupePolicy}
              onBack={() => setStep('map')}
              onCommit={handleCommit}
              isCommitting={commit.isPending}
            />
          )}
          {step === 'progress' && jobId && (
            <ProgressStep jobId={jobId} onStartNew={reset} />
          )}
        </CardContent>
      </Card>

      {/* Past imports */}
      <Card>
        <CardHeader>
          <CardTitle>{t('import.historyTitle', { defaultValue: 'Import history' })}</CardTitle>
          <CardDescription>
            {t('import.historyDesc', { defaultValue: 'Last 50 imports for this workspace.' })}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          <PastImportsList />
        </CardContent>
      </Card>
    </div>
  );
}
