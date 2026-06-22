import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus, Pencil, Trash2, BadgeDollarSign, CheckCircle2, Banknote, Users, KeyRound, Copy } from 'lucide-react';
import marketingApi from '../../../../features/marketing/api/marketingApi';
import { fmtDate } from '../../../../features/marketing/utils/format';
import { formatMoney, asWorkspaceCurrency } from '../../../../lib/money';
import {
  PageHeader,
  Button,
  IconButton,
  Badge,
  DataTable,
  EmptyState,
  ConfirmDialog,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  FilterBar,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui';
import { AffiliateFormDialog } from './AffiliateFormDialog';
import type { AffiliateFormValues } from '../schemas';
import type {
  Affiliate,
  AffiliateCommission,
  AffiliateReferral,
  CommissionStatus,
  ReferralStatus,
} from '../types';

type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const AFFILIATE_TONE: Record<string, BadgeTone> = {
  ACTIVE: 'success',
  PAUSED: 'warning',
  DISABLED: 'neutral',
};

const REFERRAL_TONE: Record<ReferralStatus, BadgeTone> = {
  PENDING: 'warning',
  CONVERTED: 'success',
  REJECTED: 'neutral',
};

const COMMISSION_TONE: Record<CommissionStatus, BadgeTone> = {
  OWED: 'warning',
  APPROVED: 'info',
  PAID: 'success',
};

function toPayload(values: AffiliateFormValues, isEdit: boolean) {
  const base = {
    name: values.name,
    email: values.email,
    code: values.code,
    commissionType: values.commissionType,
    commissionValue: values.commissionValue,
  };
  return isEdit ? { ...base, status: values.status } : base;
}

export default function AffiliatesPage() {
  const queryClient = useQueryClient();
  const { t } = useTranslation('marketing');
  // Affiliate commission amounts are workspace-currency money (Decimal strings).
  // The affiliate API doesn't echo the workspace currency, so fall back to the
  // workspace default (TRY) via asWorkspaceCurrency(undefined).
  const currency = asWorkspaceCurrency(undefined);

  const [tab, setTab] = useState<'affiliates' | 'referrals' | 'commissions'>('affiliates');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Affiliate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Affiliate | null>(null);

  // Cross-tab filter: scope referrals/commissions to a single affiliate.
  const [affiliateFilter, setAffiliateFilter] = useState('');
  const [commissionStatus, setCommissionStatus] = useState('');

  // ── Affiliates ──────────────────────────────────────────────────────────────

  const { data: affiliatesData, isLoading: affiliatesLoading } = useQuery({
    queryKey: ['marketing', 'affiliates'],
    queryFn: () => marketingApi.get('/affiliates').then((r) => r.data),
  });
  const affiliates: Affiliate[] = affiliatesData?.data ?? (Array.isArray(affiliatesData) ? affiliatesData : []);

  const affiliateName = (id: string) => affiliates.find((a) => a.id === id)?.name ?? id;

  // ── Referrals ───────────────────────────────────────────────────────────────

  // Referrals are exposed per-affiliate (GET /affiliates/:id/referrals). With no
  // filter we fan out across the loaded affiliates and merge; with a filter we
  // hit the single affiliate's route.
  const { data: referralsData, isLoading: referralsLoading } = useQuery({
    queryKey: ['marketing', 'affiliate-referrals', { affiliateId: affiliateFilter, ids: affiliates.map((a) => a.id) }],
    enabled: tab === 'referrals' && (!!affiliateFilter || affiliates.length > 0),
    queryFn: async () => {
      const ids = affiliateFilter ? [affiliateFilter] : affiliates.map((a) => a.id);
      const lists = await Promise.all(
        ids.map((id) =>
          marketingApi.get(`/affiliates/${id}/referrals`).then((r) => r.data as AffiliateReferral[]),
        ),
      );
      return lists
        .flat()
        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    },
  });
  const referrals: AffiliateReferral[] = Array.isArray(referralsData) ? referralsData : [];

  // ── Commissions ─────────────────────────────────────────────────────────────

  const { data: commissionsData, isLoading: commissionsLoading } = useQuery({
    queryKey: ['marketing', 'affiliate-commissions', { affiliateId: affiliateFilter, status: commissionStatus }],
    enabled: tab === 'commissions',
    queryFn: () =>
      marketingApi
        .get('/affiliates/commissions', {
          params: { affiliateId: affiliateFilter || undefined, status: commissionStatus || undefined },
        })
        .then((r) => r.data),
  });
  const commissions: AffiliateCommission[] = Array.isArray(commissionsData)
    ? commissionsData
    : commissionsData?.data || [];

  // ── Mutations ───────────────────────────────────────────────────────────────

  const invalidateAffiliates = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'affiliates'] });
  const invalidateCommissions = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'affiliate-commissions'] });

  const createMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => marketingApi.post('/affiliates', payload),
    onSuccess: () => {
      invalidateAffiliates();
      setFormOpen(false);
      setEditing(null);
      toast.success(t('affiliates.createSuccess', { defaultValue: 'Affiliate created' }));
    },
    onError: () => toast.error(t('affiliates.createError', { defaultValue: 'Failed to create affiliate' })),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      marketingApi.patch(`/affiliates/${id}`, data),
    onSuccess: () => {
      invalidateAffiliates();
      setFormOpen(false);
      setEditing(null);
      toast.success(t('affiliates.updateSuccess', { defaultValue: 'Affiliate updated' }));
    },
    onError: () => toast.error(t('affiliates.updateError', { defaultValue: 'Failed to update affiliate' })),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/affiliates/${id}`),
    onSuccess: () => {
      invalidateAffiliates();
      setDeleteTarget(null);
      toast.success(t('affiliates.deleteSuccess', { defaultValue: 'Affiliate deleted' }));
    },
    onError: () =>
      toast.error(
        t('affiliates.deleteError', {
          defaultValue: 'Could not delete — affiliates with referrals must be disabled instead',
        }),
      ),
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => marketingApi.patch(`/affiliates/commissions/${id}/approve`),
    onSuccess: () => {
      invalidateCommissions();
      toast.success(t('affiliates.approveSuccess', { defaultValue: 'Commission approved' }));
    },
    onError: () => toast.error(t('affiliates.approveError', { defaultValue: 'Failed to approve commission' })),
  });

  const payMutation = useMutation({
    mutationFn: (id: string) => marketingApi.patch(`/affiliates/commissions/${id}/pay`),
    onSuccess: () => {
      invalidateCommissions();
      toast.success(t('affiliates.paySuccess', { defaultValue: 'Commission marked as paid' }));
    },
    onError: () => toast.error(t('affiliates.payError', { defaultValue: 'Failed to mark commission paid' })),
  });

  // Portal token — minted server-side, shown ONCE in a dialog.
  const [portalToken, setPortalToken] = useState<string | null>(null);
  const portalTokenMutation = useMutation({
    mutationFn: (id: string) => marketingApi.post(`/affiliates/${id}/portal-token`).then((r) => r.data as { token: string }),
    onSuccess: (res) => setPortalToken(res.token),
    onError: () => toast.error(t('affiliates.portalTokenError', { defaultValue: 'Could not generate portal token' })),
  });
  const portalUrl = `${window.location.origin}/affiliate-portal`;

  const handleSubmit = (values: AffiliateFormValues) => {
    if (editing) updateMutation.mutate({ id: editing.id, data: toPayload(values, true) });
    else createMutation.mutate(toPayload(values, false));
  };

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (a: Affiliate) => {
    setEditing(a);
    setFormOpen(true);
  };
  const handleDialogClose = (open: boolean) => {
    setFormOpen(open);
    if (!open) setEditing(null);
  };

  // ── Columns ─────────────────────────────────────────────────────────────────

  const affiliateColumns: ColumnDef<Affiliate, unknown>[] = [
    {
      accessorKey: 'name',
      header: t('affiliates.table.name', { defaultValue: 'Name' }),
      cell: ({ row }) => (
        <div>
          <p className="text-sm font-medium text-foreground">{row.original.name}</p>
          <p className="text-xs text-muted-foreground">{row.original.email}</p>
        </div>
      ),
    },
    {
      accessorKey: 'code',
      header: t('affiliates.table.code', { defaultValue: 'Code' }),
      cell: ({ getValue }) => (
        <code className="rounded bg-surface-muted px-1.5 py-0.5 text-xs text-foreground">
          {getValue<string>()}
        </code>
      ),
    },
    {
      id: 'commission',
      header: t('affiliates.table.commission', { defaultValue: 'Commission' }),
      cell: ({ row }) => {
        const a = row.original;
        return (
          <span className="text-sm text-foreground tabular-nums">
            {a.commissionType === 'PERCENT'
              ? `${Number(a.commissionValue)}%`
              : formatMoney(a.commissionValue, currency)}
          </span>
        );
      },
    },
    {
      accessorKey: 'status',
      header: t('affiliates.table.status', { defaultValue: 'Status' }),
      cell: ({ getValue }) => {
        const val = getValue<string>();
        return (
          <Badge tone={AFFILIATE_TONE[val] ?? 'neutral'} size="sm">
            {t(`affiliates.statusValue.${val}`, { defaultValue: val })}
          </Badge>
        );
      },
    },
    {
      id: 'actions',
      header: '',
      size: 48,
      cell: ({ row }) => {
        const a = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton aria-label={t('common.actions', { defaultValue: 'Actions' })} size="sm" variant="ghost">
                <span className="text-lg leading-none" aria-hidden="true">⋯</span>
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => openEdit(a)}>
                <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('common.edit', { defaultValue: 'Edit' })}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  setAffiliateFilter(a.id);
                  setTab('commissions');
                }}
              >
                <BadgeDollarSign className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('affiliates.viewCommissions', { defaultValue: 'View commissions' })}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => portalTokenMutation.mutate(a.id)}>
                <KeyRound className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('affiliates.generatePortalToken', { defaultValue: 'Generate portal token' })}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-danger focus:text-danger" onClick={() => setDeleteTarget(a)}>
                <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('common.delete', { defaultValue: 'Delete' })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  const referralColumns: ColumnDef<AffiliateReferral, unknown>[] = [
    {
      accessorKey: 'affiliateId',
      header: t('affiliates.table.affiliate', { defaultValue: 'Affiliate' }),
      cell: ({ getValue }) => (
        <span className="text-sm font-medium text-foreground">{affiliateName(getValue<string>())}</span>
      ),
    },
    {
      accessorKey: 'referredLeadId',
      header: t('affiliates.table.referredLead', { defaultValue: 'Referred lead' }),
      cell: ({ getValue }) => {
        const v = getValue<string | null>();
        return v ? (
          <code className="text-xs text-muted-foreground">{v}</code>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        );
      },
    },
    {
      accessorKey: 'status',
      header: t('affiliates.table.status', { defaultValue: 'Status' }),
      cell: ({ getValue }) => {
        const val = getValue<ReferralStatus>();
        return (
          <Badge tone={REFERRAL_TONE[val] ?? 'neutral'} size="sm">
            {t(`affiliates.referralStatus.${val}`, { defaultValue: val })}
          </Badge>
        );
      },
    },
    {
      accessorKey: 'createdAt',
      header: t('affiliates.table.created', { defaultValue: 'Created' }),
      cell: ({ getValue }) => (
        <span className="text-sm text-muted-foreground">{fmtDate(getValue<string>())}</span>
      ),
    },
  ];

  const commissionColumns: ColumnDef<AffiliateCommission, unknown>[] = [
    {
      accessorKey: 'affiliateId',
      header: t('affiliates.table.affiliate', { defaultValue: 'Affiliate' }),
      cell: ({ getValue }) => (
        <span className="text-sm font-medium text-foreground">{affiliateName(getValue<string>())}</span>
      ),
    },
    {
      accessorKey: 'amount',
      header: t('affiliates.table.amount', { defaultValue: 'Amount' }),
      cell: ({ getValue }) => (
        <span className="text-sm font-medium text-foreground tabular-nums">
          {formatMoney(getValue<string>(), currency)}
        </span>
      ),
    },
    {
      accessorKey: 'status',
      header: t('affiliates.table.status', { defaultValue: 'Status' }),
      cell: ({ getValue }) => {
        const val = getValue<CommissionStatus>();
        return (
          <Badge tone={COMMISSION_TONE[val] ?? 'neutral'} size="sm">
            {t(`affiliates.commissionStatus.${val}`, { defaultValue: val })}
          </Badge>
        );
      },
    },
    {
      accessorKey: 'createdAt',
      header: t('affiliates.table.created', { defaultValue: 'Created' }),
      cell: ({ getValue }) => (
        <span className="text-sm text-muted-foreground">{fmtDate(getValue<string>())}</span>
      ),
    },
    {
      id: 'actions',
      header: '',
      size: 48,
      cell: ({ row }) => {
        const c = row.original;
        if (c.status === 'PAID') return <span className="text-sm text-muted-foreground">—</span>;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton aria-label={t('common.actions', { defaultValue: 'Actions' })} size="sm" variant="ghost">
                <span className="text-lg leading-none" aria-hidden="true">⋯</span>
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {c.status === 'OWED' && (
                <DropdownMenuItem
                  disabled={approveMutation.isPending}
                  onClick={() => approveMutation.mutate(c.id)}
                >
                  <CheckCircle2 className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('affiliates.approve', { defaultValue: 'Approve' })}
                </DropdownMenuItem>
              )}
              {c.status === 'APPROVED' && (
                <DropdownMenuItem disabled={payMutation.isPending} onClick={() => payMutation.mutate(c.id)}>
                  <Banknote className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('affiliates.markPaid', { defaultValue: 'Mark as paid' })}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  const affiliateFilterControl = (
    <Select value={affiliateFilter || '__ALL__'} onValueChange={(v) => setAffiliateFilter(v === '__ALL__' ? '' : v)}>
      <SelectTrigger className="w-56">
        <SelectValue placeholder={t('affiliates.filterAffiliate', { defaultValue: 'All affiliates' })} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__ALL__">{t('affiliates.allAffiliates', { defaultValue: 'All affiliates' })}</SelectItem>
        {affiliates.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('affiliates.title', { defaultValue: 'Affiliates' })}
        description={t('affiliates.subtitle', {
          defaultValue: 'Manage affiliates, track their referrals, and approve and pay commissions.',
        })}
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('affiliates.createButton', { defaultValue: 'New affiliate' })}
          </Button>
        }
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="affiliates">
            {t('affiliates.tabs.affiliates', { defaultValue: 'Affiliates' })}
          </TabsTrigger>
          <TabsTrigger value="referrals">
            {t('affiliates.tabs.referrals', { defaultValue: 'Referrals' })}
          </TabsTrigger>
          <TabsTrigger value="commissions">
            {t('affiliates.tabs.commissions', { defaultValue: 'Commissions' })}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="affiliates" className="pt-4">
          <DataTable
            columns={affiliateColumns}
            data={affiliates}
            isLoading={affiliatesLoading}
            loadingRowCount={6}
            emptyState={
              <EmptyState
                icon={<Users className="h-10 w-10" />}
                title={t('affiliates.empty', { defaultValue: 'No affiliates yet' })}
                description={t('affiliates.emptyHint', {
                  defaultValue: 'Add an affiliate with a unique referral code to start tracking referrals.',
                })}
                action={
                  <Button onClick={openCreate} variant="outline">
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    {t('affiliates.createButton', { defaultValue: 'New affiliate' })}
                  </Button>
                }
              />
            }
          />
        </TabsContent>

        <TabsContent value="referrals" className="space-y-4 pt-4">
          <FilterBar>{affiliateFilterControl}</FilterBar>
          <DataTable
            columns={referralColumns}
            data={referrals}
            isLoading={referralsLoading}
            loadingRowCount={6}
            emptyState={
              <EmptyState
                icon={<Users className="h-10 w-10" />}
                title={t('affiliates.referralsEmpty', { defaultValue: 'No referrals' })}
                description={t('affiliates.referralsEmptyHint', {
                  defaultValue: 'Referrals tracked to your affiliates appear here.',
                })}
              />
            }
          />
        </TabsContent>

        <TabsContent value="commissions" className="space-y-4 pt-4">
          <FilterBar>
            {affiliateFilterControl}
            <Select
              value={commissionStatus || '__ALL__'}
              onValueChange={(v) => setCommissionStatus(v === '__ALL__' ? '' : v)}
            >
              <SelectTrigger className="w-44">
                <SelectValue placeholder={t('affiliates.filterStatus', { defaultValue: 'All statuses' })} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__ALL__">{t('common.all', { defaultValue: 'All' })}</SelectItem>
                <SelectItem value="OWED">{t('affiliates.commissionStatus.OWED', { defaultValue: 'Owed' })}</SelectItem>
                <SelectItem value="APPROVED">{t('affiliates.commissionStatus.APPROVED', { defaultValue: 'Approved' })}</SelectItem>
                <SelectItem value="PAID">{t('affiliates.commissionStatus.PAID', { defaultValue: 'Paid' })}</SelectItem>
              </SelectContent>
            </Select>
          </FilterBar>
          <DataTable
            columns={commissionColumns}
            data={commissions}
            isLoading={commissionsLoading}
            loadingRowCount={6}
            emptyState={
              <EmptyState
                icon={<BadgeDollarSign className="h-10 w-10" />}
                title={t('affiliates.commissionsEmpty', { defaultValue: 'No commissions' })}
                description={t('affiliates.commissionsEmptyHint', {
                  defaultValue: 'Commissions are created when a referral converts. Approve then mark them paid.',
                })}
              />
            }
          />
        </TabsContent>
      </Tabs>

      <AffiliateFormDialog
        open={formOpen}
        onOpenChange={handleDialogClose}
        affiliate={editing}
        onSubmit={handleSubmit}
        isPending={createMutation.isPending || updateMutation.isPending}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t('affiliates.deleteTitle', { defaultValue: 'Delete affiliate' })}
        description={t('affiliates.deleteDesc', {
          defaultValue: 'This permanently removes the affiliate. Affiliates with referrals must be disabled instead.',
        })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        onConfirm={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
        loading={deleteMutation.isPending}
      />

      {/* Portal token — shown once; the affiliate signs into the portal with it. */}
      <Dialog open={!!portalToken} onOpenChange={(o) => { if (!o) setPortalToken(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('affiliates.portalTokenTitle', { defaultValue: 'Affiliate portal access' })}</DialogTitle>
            <DialogDescription>
              {t('affiliates.portalTokenDesc', { defaultValue: 'Copy this token now — it is shown only once. Share it with the affiliate to sign into the portal.' })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">{t('affiliates.portalUrl', { defaultValue: 'Portal URL' })}</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded border border-border bg-surface-muted px-2 py-1.5 text-xs">{portalUrl}</code>
                <IconButton size="sm" variant="ghost" aria-label={t('common.copy', { defaultValue: 'Copy' })} onClick={() => navigator.clipboard.writeText(portalUrl)}>
                  <Copy className="h-4 w-4" />
                </IconButton>
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-muted-foreground">{t('affiliates.portalToken', { defaultValue: 'Token' })}</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded border border-border bg-surface-muted px-2 py-1.5 font-mono text-xs">{portalToken}</code>
                <IconButton size="sm" variant="ghost" aria-label={t('common.copy', { defaultValue: 'Copy' })} onClick={() => portalToken && navigator.clipboard.writeText(portalToken)}>
                  <Copy className="h-4 w-4" />
                </IconButton>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setPortalToken(null)}>{t('common.done', { defaultValue: 'Done' })}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
