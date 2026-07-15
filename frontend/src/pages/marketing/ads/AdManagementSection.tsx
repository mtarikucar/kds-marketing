import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Play, Pause, Copy, Plus, Check, X, Pencil, AlertTriangle, Megaphone, Rocket } from 'lucide-react';
import {
  listCampaigns,
  setEntityStatus,
  setEntityBudget,
  duplicateCampaign,
  createCampaign,
  launchAd,
  type AdAccount,
  type AdCampaign,
  type LaunchAdPayload,
} from '../../../features/marketing/api/ads.service';
import { CampaignDialog } from './CampaignDialog';
import { LaunchAdDialog } from './LaunchAdDialog';
import type { CreateCampaignFormValues } from './adManagementSchemas';
import { formatMoney } from '../../../lib/money';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table';

function statusTone(effective: string): 'success' | 'warning' | 'danger' | 'neutral' {
  const s = effective.toUpperCase();
  if (s === 'ACTIVE') return 'success';
  if (s === 'PAUSED') return 'warning';
  if (s.includes('DISAPPROVED') || s.includes('ERROR') || s.includes('REJECTED')) return 'danger';
  return 'neutral';
}

interface AdManagementSectionProps {
  account: AdAccount;
}

export function AdManagementSection({ account }: AdManagementSectionProps) {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  // Use the ad account's REAL provider currency (any ISO code, e.g. CAD/JPY) —
  // not asWorkspaceCurrency, which coerced anything outside TRY/USD/EUR/GBP to ₺.
  const currency = account.currency || 'USD';
  const tokenExpired = account.status === 'TOKEN_EXPIRED';

  const [createOpen, setCreateOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [editingBudgetId, setEditingBudgetId] = useState<string | null>(null);
  const [budgetDraft, setBudgetDraft] = useState('');

  const campaignsKey = ['marketing', 'ads', 'campaigns', account.id];

  const { data, isLoading, isError } = useQuery({
    queryKey: campaignsKey,
    queryFn: () => listCampaigns(account.id),
    enabled: !tokenExpired,
  });

  const campaigns: AdCampaign[] = Array.isArray(data) ? data : [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: campaignsKey });

  const statusMutation = useMutation({
    mutationFn: ({ entityId, status }: { entityId: string; status: 'ACTIVE' | 'PAUSED' }) =>
      setEntityStatus(account.id, entityId, status),
    onSuccess: () => {
      invalidate();
      toast.success(t('ads.manage.toast.statusUpdated', { defaultValue: 'Status updated' }));
    },
    onError: () => toast.error(t('ads.manage.toast.statusFailed', { defaultValue: 'Failed to update status' })),
  });

  const budgetMutation = useMutation({
    mutationFn: ({ entityId, dailyBudget }: { entityId: string; dailyBudget: number }) =>
      setEntityBudget(account.id, entityId, dailyBudget),
    onSuccess: () => {
      invalidate();
      setEditingBudgetId(null);
      toast.success(t('ads.manage.toast.budgetUpdated', { defaultValue: 'Budget updated' }));
    },
    onError: () => toast.error(t('ads.manage.toast.budgetFailed', { defaultValue: 'Failed to update budget' })),
  });

  const duplicateMutation = useMutation({
    mutationFn: (campaignId: string) => duplicateCampaign(account.id, campaignId),
    onSuccess: () => {
      invalidate();
      toast.success(t('ads.manage.toast.duplicated', { defaultValue: 'Campaign duplicated' }));
    },
    onError: () => toast.error(t('ads.manage.toast.duplicateFailed', { defaultValue: 'Failed to duplicate campaign' })),
  });

  const createMutation = useMutation({
    mutationFn: (values: CreateCampaignFormValues) => createCampaign(account.id, values),
    onSuccess: () => {
      invalidate();
      setCreateOpen(false);
      toast.success(t('ads.manage.toast.created', { defaultValue: 'Campaign created' }));
    },
    onError: () => toast.error(t('ads.manage.toast.createFailed', { defaultValue: 'Failed to create campaign' })),
  });

  const launchMutation = useMutation({
    mutationFn: (payload: LaunchAdPayload) => launchAd(account.id, payload),
    onSuccess: () => {
      invalidate();
      setLaunchOpen(false);
      toast.success(t('ads.manage.toast.launched', { defaultValue: 'Ad launched (paused)' }));
    },
    onError: (e) =>
      toast.error(
        (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
          t('ads.manage.toast.launchFailed', { defaultValue: 'Failed to launch ad' }),
      ),
  });

  const beginEditBudget = (c: AdCampaign) => {
    setEditingBudgetId(c.id);
    setBudgetDraft(c.dailyBudget != null ? String(c.dailyBudget) : '');
  };

  const saveBudget = (entityId: string) => {
    const value = Number(budgetDraft);
    // Mirror the backend SetBudgetDto @Min(0.01) so a sub-minimum amount gets an
    // inline message instead of an opaque server 400.
    if (!Number.isFinite(value) || value < 0.01) {
      toast.error(t('ads.manage.toast.budgetInvalid', { defaultValue: 'Enter a valid budget amount' }));
      return;
    }
    budgetMutation.mutate({ entityId, dailyBudget: value });
  };

  if (tokenExpired) {
    return (
      <Card className="p-0">
        <SectionHeader title={t('ads.manage.title', { defaultValue: 'Campaigns' })} />
        <div className="flex items-start gap-2 px-4 py-6 text-sm text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            {t('ads.manage.tokenExpired', {
              defaultValue: 'This account’s access has expired. Reconnect it (Accounts tab) to manage campaigns.',
            })}
          </span>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-0">
      <SectionHeader
        title={t('ads.manage.title', { defaultValue: 'Campaigns' })}
        action={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setLaunchOpen(true)}>
              <Rocket className="h-4 w-4" aria-hidden="true" />
              {t('ads.manage.launchAd', { defaultValue: 'Launch ad' })}
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('ads.manage.newCampaign', { defaultValue: 'New campaign' })}
            </Button>
          </div>
        }
      />

      {isLoading ? (
        <div className="space-y-2 p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : isError ? (
        <div className="flex items-start gap-2 px-4 py-6 text-sm text-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t('ads.manage.loadFailed', { defaultValue: 'Could not load campaigns. Try refreshing.' })}</span>
        </div>
      ) : campaigns.length === 0 ? (
        <EmptyState
          icon={<Megaphone className="h-10 w-10" />}
          title={t('ads.manage.empty', { defaultValue: 'No campaigns' })}
          description={t('ads.manage.emptyHint', {
            defaultValue: 'Create a campaign to start managing budgets and status here.',
          })}
          action={
            <Button variant="outline" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('ads.manage.newCampaign', { defaultValue: 'New campaign' })}
            </Button>
          }
        />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>{t('ads.manage.col.name', { defaultValue: 'Campaign' })}</TH>
              <TH>{t('ads.manage.col.status', { defaultValue: 'Status' })}</TH>
              <TH>{t('ads.manage.col.objective', { defaultValue: 'Objective' })}</TH>
              <TH className="text-right">{t('ads.manage.col.dailyBudget', { defaultValue: 'Daily budget' })}</TH>
              <TH className="text-right">{t('ads.manage.col.actions', { defaultValue: 'Actions' })}</TH>
            </TR>
          </THead>
          <TBody>
            {campaigns.map((c) => {
              const isActive = c.status.toUpperCase() === 'ACTIVE';
              const editing = editingBudgetId === c.id;
              const statusPending =
                statusMutation.isPending && statusMutation.variables?.entityId === c.id;
              const dupPending = duplicateMutation.isPending && duplicateMutation.variables === c.id;
              return (
                <TR key={c.id}>
                  <TD>
                    <span className="font-medium text-foreground">{c.name}</span>
                  </TD>
                  <TD>
                    <div className="flex flex-col gap-0.5">
                      <Badge tone={statusTone(c.status)} size="sm">
                        {t(`ads.entityStatus.${c.status.toUpperCase()}`, { defaultValue: c.status })}
                      </Badge>
                      {c.effectiveStatus && c.effectiveStatus.toUpperCase() !== c.status.toUpperCase() && (
                        <span className="text-micro text-muted-foreground" title={t('ads.manage.effectiveHint', { defaultValue: 'Effective status (as Meta delivers it)' })}>
                          {c.effectiveStatus}
                        </span>
                      )}
                    </div>
                  </TD>
                  <TD className="text-muted-foreground">{c.objective ?? '—'}</TD>
                  <TD className="text-right">
                    {editing ? (
                      <div className="flex items-center justify-end gap-1">
                        <Input
                          type="number"
                          step="any"
                          min={0}
                          autoFocus
                          value={budgetDraft}
                          onChange={(e) => setBudgetDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveBudget(c.id);
                            if (e.key === 'Escape') setEditingBudgetId(null);
                          }}
                          className="h-8 w-28 text-right"
                          aria-label={t('ads.manage.col.dailyBudget', { defaultValue: 'Daily budget' })}
                        />
                        <IconButton
                          variant="ghost"
                          size="sm"
                          aria-label={t('common.save', { defaultValue: 'Save' })}
                          onClick={() => saveBudget(c.id)}
                          disabled={budgetMutation.isPending}
                        >
                          <Check className="h-4 w-4" aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          variant="ghost"
                          size="sm"
                          aria-label={t('common.cancel', { defaultValue: 'Cancel' })}
                          onClick={() => setEditingBudgetId(null)}
                        >
                          <X className="h-4 w-4" aria-hidden="true" />
                        </IconButton>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => beginEditBudget(c)}
                        className="group inline-flex items-center gap-1 tabular-nums hover:text-primary"
                        title={t('ads.manage.editBudget', { defaultValue: 'Edit daily budget' })}
                      >
                        {c.dailyBudget != null ? formatMoney(c.dailyBudget, currency) : '—'}
                        <Pencil className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
                      </button>
                    )}
                  </TD>
                  <TD>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        loading={statusPending}
                        onClick={() =>
                          statusMutation.mutate({
                            entityId: c.id,
                            status: isActive ? 'PAUSED' : 'ACTIVE',
                          })
                        }
                      >
                        {isActive ? (
                          <>
                            <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                            {t('ads.manage.pause', { defaultValue: 'Pause' })}
                          </>
                        ) : (
                          <>
                            <Play className="h-3.5 w-3.5" aria-hidden="true" />
                            {t('ads.manage.resume', { defaultValue: 'Resume' })}
                          </>
                        )}
                      </Button>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label={t('ads.manage.duplicate', { defaultValue: 'Duplicate campaign' })}
                        onClick={() => duplicateMutation.mutate(c.id)}
                        disabled={dupPending}
                      >
                        <Copy className="h-4 w-4" aria-hidden="true" />
                      </IconButton>
                    </div>
                  </TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}

      <CampaignDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={(values) => createMutation.mutate(values)}
        isPending={createMutation.isPending}
      />

      <LaunchAdDialog
        open={launchOpen}
        onOpenChange={setLaunchOpen}
        onSubmit={(payload) => launchMutation.mutate(payload)}
        isPending={launchMutation.isPending}
      />
    </Card>
  );
}

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {action}
    </div>
  );
}
