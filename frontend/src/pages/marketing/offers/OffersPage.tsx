import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, FileText } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import marketingApi from '../../../features/marketing/api/marketingApi';
import type { LeadOffer, Lead, PaginatedResponse } from '../../../features/marketing/types';
import type { OfferFormValues } from '../../../features/marketing/schemas';
import { fmtDate } from '../../../features/marketing/utils/format';
import { formatMoney } from '../../../lib/money';

import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { FilterBar } from '@/components/ui/FilterBar';
import { Pagination } from '@/components/ui/Pagination';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { IconButton } from '@/components/ui/IconButton';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { OfferFormDialog } from './OfferFormDialog';

// ── Badge tone map ─────────────────────────────────────────────────────────

type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const STATUS_TONE: Record<string, BadgeTone> = {
  DRAFT: 'neutral',
  SENT: 'info',
  ACCEPTED: 'success',
  REJECTED: 'danger',
  EXPIRED: 'warning',
};

const OFFER_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'] as const;

// ── Component ─────────────────────────────────────────────────────────────

export default function OffersPage() {
  const queryClient = useQueryClient();
  const { t } = useTranslation('marketing');
  const [searchParams] = useSearchParams();

  // Filter state — seed status from URL (?status=SENT) for deep-links
  const [status, setStatus] = useState(searchParams.get('status') ?? '');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [showDateFilters, setShowDateFilters] = useState(false);

  // Dialog / form state
  const [formOpen, setFormOpen] = useState(false);
  const [editingOffer, setEditingOffer] = useState<LeadOffer | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LeadOffer | null>(null);

  // ── Queries ────────────────────────────────────────────────────────────

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['marketing', 'offers', { status, dateFrom, dateTo, page }],
    queryFn: () =>
      marketingApi
        .get<PaginatedResponse<LeadOffer>>('/offers', {
          params: {
            status: status || undefined,
            dateFrom: dateFrom || undefined,
            dateTo: dateTo || undefined,
            page,
            limit: 20,
          },
        })
        .then((r) => r.data),
  });

  const offers: LeadOffer[] = data?.data || [];
  const meta = data?.meta;

  // Fetch leads for the create form dropdown
  const { data: leadsData } = useQuery({
    queryKey: ['marketing', 'leads', 'dropdown'],
    queryFn: () =>
      marketingApi
        .get<PaginatedResponse<Lead>>('/leads', { params: { limit: 100 } })
        .then((r) => r.data),
  });

  const leads: Lead[] = leadsData?.data || [];

  // ── Mutations ──────────────────────────────────────────────────────────

  const invalidateOffers = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'offers'] });

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      marketingApi.post('/offers', payload),
    onSuccess: () => {
      toast.success(t('offers.createSuccess'));
      invalidateOffers();
      setFormOpen(false);
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message || 'Failed to create offer');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
      marketingApi.patch(`/offers/${id}`, payload),
    onSuccess: () => {
      toast.success('Offer updated successfully');
      invalidateOffers();
      setEditingOffer(null);
      setFormOpen(false);
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message || 'Failed to update offer');
    },
  });

  const sendMutation = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/offers/${id}/send`),
    onSuccess: () => {
      toast.success(t('offers.sentSuccess'));
      invalidateOffers();
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message || 'Failed to send offer');
    },
  });

  const acceptMutation = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/offers/${id}/accept`),
    onSuccess: () => {
      toast.success('Offer accepted');
      invalidateOffers();
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message || 'Failed to accept offer');
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/offers/${id}/reject`),
    onSuccess: () => {
      toast.success('Offer rejected');
      invalidateOffers();
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message || 'Failed to reject offer');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/offers/${id}`),
    onSuccess: () => {
      toast.success(t('offers.deleteSuccess'));
      invalidateOffers();
      setDeleteTarget(null);
    },
    onError: (err: any) => {
      toast.error(err?.response?.data?.message || 'Failed to delete offer');
    },
  });

  // ── Form submit handler ────────────────────────────────────────────────

  function buildPayload(values: OfferFormValues): Record<string, unknown> {
    return {
      leadId: values.leadId || undefined,
      planId: values.planId || undefined,
      customPrice: values.customPrice !== undefined ? values.customPrice : undefined,
      discount: values.discount !== undefined ? values.discount : undefined,
      trialDays: values.trialDays !== undefined ? values.trialDays : undefined,
      notes: values.notes || undefined,
      validUntil: values.validUntil || undefined,
    };
  }

  function handleFormSubmit(values: OfferFormValues) {
    if (editingOffer) {
      updateMutation.mutate({ id: editingOffer.id, payload: buildPayload(values) });
    } else {
      createMutation.mutate(buildPayload(values));
    }
  }

  function openCreate() {
    setEditingOffer(null);
    setFormOpen(true);
  }

  function openEdit(offer: LeadOffer) {
    setEditingOffer(offer);
    setFormOpen(true);
  }

  function handleDialogClose(open: boolean) {
    setFormOpen(open);
    if (!open) setEditingOffer(null);
  }

  function clearFilters() {
    setStatus('');
    setDateFrom('');
    setDateTo('');
    setPage(1);
  }

  const hasFilters = !!(status || dateFrom || dateTo);

  // ── Columns ────────────────────────────────────────────────────────────

  const columns: ColumnDef<LeadOffer, unknown>[] = useMemo(
    () => [
      {
        accessorKey: 'lead',
        header: t('offers.table.lead'),
        cell: ({ row }) => {
          const offer = row.original;
          if (!offer.lead) return <span className="text-muted-foreground">—</span>;
          return (
            <Link
              to={`/leads/${offer.lead.id}`}
              className="font-medium text-primary hover:text-primary/80 hover:underline"
            >
              {offer.lead.businessName}
            </Link>
          );
        },
      },
      {
        accessorKey: 'status',
        header: t('offers.table.status'),
        cell: ({ getValue }) => {
          const val = getValue<string>();
          return (
            <Badge tone={STATUS_TONE[val] ?? 'neutral'} size="sm">
              {t(`offerStatus.${val}`, { defaultValue: val })}
            </Badge>
          );
        },
      },
      {
        accessorKey: 'customPrice',
        header: t('offers.table.amount'),
        cell: ({ getValue }) => {
          const val = getValue<number | undefined>();
          return val != null ? (
            <span className="text-sm text-foreground">{formatMoney(val)}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          );
        },
      },
      {
        accessorKey: 'discount',
        header: t('offers.table.discount'),
        cell: ({ getValue }) => {
          const val = getValue<number | undefined>();
          return val != null ? (
            <span className="text-sm text-foreground">{val}%</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          );
        },
      },
      {
        accessorKey: 'trialDays',
        header: 'Trial',
        cell: ({ getValue }) => {
          const val = getValue<number | undefined>();
          return val != null ? (
            <span className="text-sm text-foreground">{val}d</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          );
        },
      },
      {
        accessorKey: 'validUntil',
        header: t('offers.table.validUntil'),
        cell: ({ getValue }) => {
          const val = getValue<string | undefined>();
          return val ? (
            <span className="text-sm text-muted-foreground">{fmtDate(val)}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          );
        },
      },
      {
        accessorKey: 'createdBy',
        header: 'Created By',
        cell: ({ row }) => {
          const u = row.original.createdBy;
          if (!u) return <span className="text-muted-foreground">—</span>;
          return (
            <span className="text-sm text-foreground">
              {u.firstName} {u.lastName}
            </span>
          );
        },
      },
      {
        accessorKey: 'createdAt',
        header: t('offers.table.createdAt'),
        cell: ({ getValue }) => (
          <span className="text-sm text-muted-foreground">{fmtDate(getValue<string>())}</span>
        ),
      },
      {
        id: 'actions',
        header: '',
        size: 48,
        cell: ({ row }) => {
          const offer = row.original;
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton aria-label={t('common.actions')} size="sm" variant="ghost">
                  <span className="text-lg leading-none" aria-hidden="true">⋯</span>
                </IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {offer.status === 'DRAFT' && (
                  <>
                    <DropdownMenuItem
                      onClick={() => {
                        // Sending transmits the price quote to the customer and
                        // can't be unsent — confirm first (matches the lead-detail
                        // Offers tab, so the same action is guarded everywhere).
                        if (
                          window.confirm(
                            t('offers.confirmSend', {
                              defaultValue:
                                'Send this offer to the customer? This cannot be undone.',
                            }),
                          )
                        ) {
                          sendMutation.mutate(offer.id);
                        }
                      }}
                      // Scope the in-flight guard to THIS offer — a bare
                      // sendMutation.isPending disables Send on every other
                      // offer's menu while one send is running.
                      disabled={sendMutation.isPending && sendMutation.variables === offer.id}
                    >
                      {t('offers.actions.send')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => openEdit(offer)}>
                      {t('offers.actions.edit')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-danger focus:text-danger"
                      onClick={() => setDeleteTarget(offer)}
                    >
                      {t('offers.actions.delete')}
                    </DropdownMenuItem>
                  </>
                )}
                {offer.status === 'SENT' && (
                  <>
                    <DropdownMenuItem
                      onClick={() => acceptMutation.mutate(offer.id)}
                      disabled={acceptMutation.isPending && acceptMutation.variables === offer.id}
                    >
                      {t('offers.actions.accept')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-danger focus:text-danger"
                      onClick={() => rejectMutation.mutate(offer.id)}
                      disabled={rejectMutation.isPending && rejectMutation.variables === offer.id}
                    >
                      {t('offers.actions.reject')}
                    </DropdownMenuItem>
                  </>
                )}
                {offer.status !== 'DRAFT' && offer.status !== 'SENT' && (
                  <DropdownMenuItem
                    disabled
                    className="text-muted-foreground"
                  >
                    {t(`offerStatus.${offer.status}`, { defaultValue: offer.status })}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, sendMutation.isPending, acceptMutation.isPending, rejectMutation.isPending],
  );

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      {/* Page header */}
      <PageHeader
        title={t('offers.title')}
        description={t('offers.subtitle')}
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('offers.createButton')}
          </Button>
        }
      />

      {/* Filter row */}
      <FilterBar>
        {/* Status filter */}
        <Select
          value={status || '__ALL__'}
          onValueChange={(v) => {
            setStatus(v === '__ALL__' ? '' : v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder={t('offers.filterStatus')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__ALL__">{t('common.all')}</SelectItem>
            {OFFER_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {t(`offerStatus.${s}`, { defaultValue: s })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Toggle date range */}
        <Button
          variant={showDateFilters ? 'secondary' : 'outline'}
          size="sm"
          onClick={() => setShowDateFilters((prev) => !prev)}
        >
          {t('common.filters')}
        </Button>

        {/* Clear filters */}
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </FilterBar>

      {/* Date range (collapsible) */}
      {showDateFilters && (
        <div className="flex flex-wrap gap-3 items-end rounded-lg border border-border bg-surface p-4">
          <div className="flex flex-col gap-1">
            <label className="text-caption text-muted-foreground">{t('offers.filterFrom')}</label>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setPage(1);
              }}
              className="w-40"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-caption text-muted-foreground">{t('offers.filterTo')}</label>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setPage(1);
              }}
              className="w-40"
            />
          </div>
        </div>
      )}

      {/* Error state */}
      {isError && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-danger/30 bg-danger-subtle p-6 text-center">
          <p className="text-sm text-danger">Could not load offers.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )}

      {/* Offers table */}
      {!isError && (
        <DataTable
          columns={columns}
          data={offers}
          isLoading={isLoading}
          loadingRowCount={6}
          emptyState={
            <EmptyState
              icon={<FileText className="h-10 w-10" />}
              title={t('offers.empty')}
              description={t('offers.subtitle')}
              action={
                <Button onClick={openCreate} variant="outline">
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t('offers.createButton')}
                </Button>
              }
            />
          }
        />
      )}

      {/* Pagination */}
      {meta && meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {t('common.page')} {meta.page} {t('common.of')} {meta.totalPages} — {meta.total} total
          </p>
          <Pagination
            page={page}
            pageCount={meta.totalPages}
            onPage={(p) => setPage(p)}
          />
        </div>
      )}

      {/* Create / Edit dialog */}
      <OfferFormDialog
        open={formOpen}
        onOpenChange={handleDialogClose}
        offer={editingOffer}
        leads={leads}
        onSubmit={handleFormSubmit}
        isPending={createMutation.isPending || updateMutation.isPending}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={`${t('common.delete')} offer`}
        description="This action cannot be undone."
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        loading={deleteMutation.isPending}
      />
    </div>
  );
}
