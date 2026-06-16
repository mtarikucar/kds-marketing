import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Search,
  Download,
  Trash2,
  FileText,
  CheckCircle2,
  XCircle,
  ScrollText,
} from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  PageHeader,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Button,
  Badge,
  Input,
  DataTable,
  EmptyState,
  ConfirmDialog,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Skeleton,
  Separator,
} from '@/components/ui';
import { fmtDateTime } from '@/features/marketing/utils/format';
import {
  useDataRequests,
  useLeadSearch,
  useLeadConsents,
  useComplianceMutations,
} from './hooks';
import type { ComplianceLead, ConsentRecord, DataRequest } from './types';

function apiError(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data
    ?.message;
  if (Array.isArray(msg)) return msg[0];
  return msg ?? fallback;
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function CompliancePage() {
  const { t } = useTranslation('marketing');

  const [search, setSearch] = useState('');
  const [selectedLead, setSelectedLead] = useState<ComplianceLead | null>(null);
  const [erasureOpen, setErasureOpen] = useState(false);

  const { data: searchResults, isFetching: searching } = useLeadSearch(search);
  const { data: consents, isLoading: consentsLoading } = useLeadConsents(selectedLead?.id ?? null);
  const { data: requests, isLoading: requestsLoading } = useDataRequests();
  const { exportData, erasure } = useComplianceMutations();

  const handleExport = () => {
    if (!selectedLead) return;
    exportData.mutate(selectedLead.id, {
      onSuccess: (bundle) => {
        downloadJson(`lead-${selectedLead.id}-export.json`, bundle);
        toast.success(t('compliance.exportDone', { defaultValue: 'Data export downloaded' }));
      },
      onError: (e) => toast.error(apiError(e, t('compliance.exportError', { defaultValue: 'Failed to export data' }))),
    });
  };

  const handleErasure = () => {
    if (!selectedLead) return;
    erasure.mutate(selectedLead.id, {
      onSuccess: () => {
        setErasureOpen(false);
        toast.success(t('compliance.erasureDone', { defaultValue: 'Erasure request recorded (pending review)' }));
      },
      onError: (e) => toast.error(apiError(e, t('compliance.erasureError', { defaultValue: 'Failed to request erasure' }))),
    });
  };

  const leadLabel = (l: ComplianceLead) =>
    l.businessName || l.contactPerson || l.email || l.id;

  // ── Requests history columns ───────────────────────────────────────────────
  const requestColumns: ColumnDef<DataRequest, unknown>[] = [
    {
      accessorKey: 'kind',
      header: t('compliance.req.kind', { defaultValue: 'Type' }),
      cell: ({ getValue }) => {
        const k = getValue<string>();
        return (
          <Badge tone={k === 'EXPORT' ? 'info' : 'warning'} size="sm">
            {k === 'EXPORT'
              ? t('compliance.req.export', { defaultValue: 'Export' })
              : t('compliance.req.erasure', { defaultValue: 'Erasure' })}
          </Badge>
        );
      },
    },
    {
      accessorKey: 'status',
      header: t('compliance.req.status', { defaultValue: 'Status' }),
      cell: ({ getValue }) => {
        const s = getValue<string>();
        const tone = s === 'COMPLETED' ? 'success' : s === 'REJECTED' ? 'danger' : 'neutral';
        return (
          <Badge tone={tone} size="sm">
            {t(`compliance.status.${s}`, { defaultValue: s })}
          </Badge>
        );
      },
    },
    {
      accessorKey: 'leadId',
      header: t('compliance.req.lead', { defaultValue: 'Lead' }),
      cell: ({ getValue }) => (
        <code className="text-xs text-muted-foreground">{getValue<string>() ?? '—'}</code>
      ),
    },
    {
      accessorKey: 'requestedAt',
      header: t('compliance.req.requestedAt', { defaultValue: 'Requested' }),
      cell: ({ getValue }) => (
        <span className="text-sm text-muted-foreground">{fmtDateTime(getValue<string>())}</span>
      ),
    },
    {
      accessorKey: 'completedAt',
      header: t('compliance.req.completedAt', { defaultValue: 'Completed' }),
      cell: ({ getValue }) => {
        const v = getValue<string | null>();
        return <span className="text-sm text-muted-foreground">{v ? fmtDateTime(v) : '—'}</span>;
      },
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('compliance.title', { defaultValue: 'Compliance' })}
        description={t('compliance.subtitle', {
          defaultValue: 'Consent records and GDPR/KVKK data-subject requests (export and erasure).',
        })}
      />

      <Tabs defaultValue="subject">
        <TabsList>
          <TabsTrigger value="subject">
            {t('compliance.tabs.subject', { defaultValue: 'Data subject' })}
          </TabsTrigger>
          <TabsTrigger value="requests">
            {t('compliance.tabs.requests', { defaultValue: 'Request history' })}
          </TabsTrigger>
        </TabsList>

        {/* ── Data subject tab ── */}
        <TabsContent value="subject" className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>{t('compliance.findLead', { defaultValue: 'Find a lead' })}</CardTitle>
              <CardDescription>
                {t('compliance.findLeadDesc', {
                  defaultValue: 'Search by business name, contact or email to view consent and run requests.',
                })}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="relative max-w-md">
                <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('compliance.searchPlaceholder', { defaultValue: 'Search leads…' })}
                  className="ps-9"
                  aria-label={t('compliance.searchPlaceholder', { defaultValue: 'Search leads' })}
                />
              </div>

              {search.trim().length >= 2 && (
                <div className="rounded-lg border border-border">
                  {searching ? (
                    <div className="space-y-2 p-3">
                      {Array.from({ length: 3 }).map((_, i) => (
                        <Skeleton key={i} className="h-8 w-full" />
                      ))}
                    </div>
                  ) : (searchResults ?? []).length === 0 ? (
                    <p className="px-3 py-4 text-sm text-muted-foreground">
                      {t('compliance.noLeads', { defaultValue: 'No matching leads.' })}
                    </p>
                  ) : (
                    <ul className="divide-y divide-border">
                      {(searchResults ?? []).map((l) => (
                        <li key={l.id}>
                          <button
                            type="button"
                            onClick={() => setSelectedLead(l)}
                            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-start text-sm hover:bg-surface-muted"
                          >
                            <span className="min-w-0">
                              <span className="block truncate font-medium text-foreground">
                                {leadLabel(l)}
                              </span>
                              {l.email && (
                                <span className="block truncate text-caption text-muted-foreground">
                                  {l.email}
                                </span>
                              )}
                            </span>
                            {selectedLead?.id === l.id && (
                              <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {selectedLead && (
            <Card>
              <CardHeader>
                <CardTitle>{leadLabel(selectedLead)}</CardTitle>
                <CardDescription>
                  {t('compliance.selectedDesc', {
                    defaultValue: 'Consent on record and available data-subject actions.',
                  })}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                {/* Consent records */}
                <div>
                  <p className="mb-2 text-sm font-medium text-foreground">
                    {t('compliance.consentRecords', { defaultValue: 'Consent records' })}
                  </p>
                  {consentsLoading ? (
                    <div className="space-y-2">
                      {Array.from({ length: 2 }).map((_, i) => (
                        <Skeleton key={i} className="h-9 w-full" />
                      ))}
                    </div>
                  ) : (consents ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t('compliance.noConsent', { defaultValue: 'No consent records for this lead.' })}
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {(consents as ConsentRecord[]).map((c) => (
                        <li
                          key={c.type}
                          className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
                        >
                          <div className="flex items-center gap-2">
                            {c.granted ? (
                              <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
                            ) : (
                              <XCircle className="h-4 w-4 text-danger" aria-hidden="true" />
                            )}
                            <span className="text-sm font-medium text-foreground">
                              {t(`compliance.consentType.${c.type}`, {
                                defaultValue: c.type.replace(/_/g, ' '),
                              })}
                            </span>
                          </div>
                          <div className="flex items-center gap-3">
                            <Badge tone={c.granted ? 'success' : 'neutral'} size="sm">
                              {c.granted
                                ? t('compliance.granted', { defaultValue: 'Granted' })
                                : t('compliance.withdrawn', { defaultValue: 'Withdrawn' })}
                            </Badge>
                            <span className="text-caption text-muted-foreground">{fmtDateTime(c.at)}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <Separator />

                {/* Data-subject actions */}
                <div className="flex flex-wrap items-center gap-3">
                  <Button onClick={handleExport} loading={exportData.isPending}>
                    <Download className="h-4 w-4" aria-hidden="true" />
                    {t('compliance.requestExport', { defaultValue: 'Export data' })}
                  </Button>
                  <Button
                    variant="outline"
                    className="text-danger"
                    onClick={() => setErasureOpen(true)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    {t('compliance.requestErasure', { defaultValue: 'Request erasure' })}
                  </Button>
                </div>
                <p className="text-caption text-muted-foreground">
                  {t('compliance.actionsHint', {
                    defaultValue:
                      'Export downloads the data bundle now. Erasure is recorded as pending for review — it never auto-deletes.',
                  })}
                </p>
              </CardContent>
            </Card>
          )}

          {!selectedLead && search.trim().length < 2 && (
            <EmptyState
              icon={<FileText className="h-10 w-10" />}
              title={t('compliance.pickLeadTitle', { defaultValue: 'Select a lead to begin' })}
              description={t('compliance.pickLeadDesc', {
                defaultValue: 'Search above to view a lead’s consent records and run export or erasure.',
              })}
            />
          )}
        </TabsContent>

        {/* ── Requests history tab ── */}
        <TabsContent value="requests" className="space-y-4">
          <DataTable
            columns={requestColumns}
            data={requests ?? []}
            isLoading={requestsLoading}
            loadingRowCount={5}
            emptyState={
              <EmptyState
                icon={<ScrollText className="h-10 w-10" />}
                title={t('compliance.noRequests', { defaultValue: 'No data requests yet' })}
                description={t('compliance.noRequestsHint', {
                  defaultValue: 'Export and erasure requests you run will appear here.',
                })}
              />
            }
          />
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={erasureOpen}
        onOpenChange={setErasureOpen}
        title={t('compliance.erasureTitle', { defaultValue: 'Request data erasure' })}
        description={t('compliance.erasureDesc', {
          defaultValue:
            'This records a PENDING erasure request for review. No data is deleted automatically.',
        })}
        confirmLabel={t('compliance.requestErasure', { defaultValue: 'Request erasure' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={erasure.isPending}
        onConfirm={handleErasure}
      />
    </div>
  );
}
