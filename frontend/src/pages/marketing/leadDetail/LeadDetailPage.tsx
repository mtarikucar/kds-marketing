import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ArrowLeft, Pencil, Trash2, CheckCircle2, Printer } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useBreadcrumbLabel } from '../../../features/marketing/hooks/useBreadcrumbLabel';
import { useEntitlements } from '../../../features/marketing/hooks/useEntitlements';
import { sendFax } from '../../../features/marketing/api/fax.service';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Spinner } from '@/components/ui/Spinner';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/Select';
import { LEAD_STATUS_LABELS } from '../../../features/marketing/types';

/**
 * Frontend mirror of the backend's ALLOWED_TRANSITIONS
 * (marketing-leads.service.ts) — the header status Select offers ONLY legal
 * moves for the current status, so no option can 400. WON is excluded (owned
 * by the /convert flow); WON/LOST are terminal.
 */
const STATUS_TRANSITIONS: Record<string, string[]> = {
  NEW: ['CONTACTED', 'NOT_REACHABLE', 'LOST'],
  CONTACTED: ['MEETING_DONE', 'DEMO_SCHEDULED', 'NOT_REACHABLE', 'WAITING', 'LOST'],
  NOT_REACHABLE: ['CONTACTED', 'LOST'],
  MEETING_DONE: ['DEMO_SCHEDULED', 'OFFER_SENT', 'WAITING', 'LOST'],
  DEMO_SCHEDULED: ['MEETING_DONE', 'OFFER_SENT', 'WAITING', 'LOST'],
  OFFER_SENT: ['WAITING', 'WON', 'LOST'],
  WAITING: ['OFFER_SENT', 'WON', 'LOST'],
  WON: [],
  LOST: [],
};
import {
  getLead,
  updateLeadStatus,
  createLeadActivity,
  createOffer,
  sendOffer,
  deleteOffer,
  createTask,
  completeTask,
  deleteTask,
  convertLead,
  deleteLead,
} from '../../../features/marketing/api/leads.service';
import { LeadStatusBadge, AssignCell } from '../../../features/marketing/components';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import ContactInfo from './ContactInfo';
import { WalletPanel } from './WalletPanel';
import { CompanyPanel } from './CompanyPanel';
import ActivityTimelineTab from './ActivityTimelineTab';
import OffersTab from './OffersTab';
import TasksTab from './TasksTab';
import ConvertDialog from './ConvertDialog';
import { useConvertDialog } from './useConvertDialog';
import SendFaxDialog from './SendFaxDialog';

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t, i18n } = useTranslation('marketing');
  // Locale-aware date formatting: `toLocaleDateString()` with no arg
  // uses the runtime locale, which on a Turkish admin's browser is
  // usually `en-US` from the OS-level default. Threading i18n.language
  // through keeps every date in the same locale the rest of the UI
  // uses, no matter what the browser thinks.
  const locale = i18n.language || 'tr';
  const fmtDate = (d: string | Date | null | undefined) =>
    d ? new Date(d).toLocaleDateString(locale) : '';
  const user = useMarketingAuthStore((s) => s.user);
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';
  const { has } = useEntitlements();

  const convert = useConvertDialog();
  const [faxOpen, setFaxOpen] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['marketing', 'lead', id] });
    // Also refresh the leads LIST + dashboard — the singular detail key does not
    // prefix-match ['marketing','leads',{filters}], so a convert/status change on
    // this page otherwise left the row stale in the list until the 30s poll.
    queryClient.invalidateQueries({ queryKey: ['marketing', 'leads'] });
    queryClient.invalidateQueries({ queryKey: ['marketing', 'dashboard'] });
  };

  const {
    data: lead,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['marketing', 'lead', id],
    queryFn: () => getLead(id!),
    // A genuine 404 (deleted lead) is the answer, not a transient failure —
    // don't burn retries on it; let the not-found branch render.
    retry: (failureCount, err: any) => (err?.response?.status === 404 ? false : failureCount < 2),
  });

  // Show the lead's name in the header breadcrumb ("Contacts › Leads › <name>").
  useBreadcrumbLabel(lead?.businessName);

  // Mutations
  const statusMutation = useMutation({
    mutationFn: (status: string) => updateLeadStatus(id!, status),
    onSuccess: () => {
      invalidate();
      toast.success('Status updated');
    },
    onError: () => toast.error('Failed to update status'),
  });

  const activityMutation = useMutation({
    mutationFn: (data: { type: string; title: string; description?: string }) =>
      createLeadActivity(id!, data),
    onSuccess: () => {
      invalidate();
      toast.success('Activity added');
    },
    onError: () => toast.error('Failed to add activity'),
  });

  const createOfferMutation = useMutation({
    mutationFn: (data: any) => createOffer(data),
    onSuccess: () => {
      invalidate();
      toast.success('Offer created');
    },
    onError: () => toast.error('Failed to create offer'),
  });

  const sendOfferMutation = useMutation({
    mutationFn: (offerId: string) => sendOffer(offerId),
    onSuccess: () => {
      invalidate();
      toast.success('Offer sent');
    },
    onError: () => toast.error('Failed to send offer'),
  });

  const deleteOfferMutation = useMutation({
    mutationFn: (offerId: string) => deleteOffer(offerId),
    onSuccess: () => {
      invalidate();
      toast.success('Offer deleted');
    },
    onError: () => toast.error('Failed to delete offer'),
  });

  const createTaskMutation = useMutation({
    mutationFn: (data: any) => createTask(data),
    onSuccess: () => {
      invalidate();
      toast.success('Task created');
    },
    onError: () => toast.error('Failed to create task'),
  });

  const completeTaskMutation = useMutation({
    mutationFn: (taskId: string) => completeTask(taskId),
    onSuccess: () => {
      invalidate();
      toast.success('Task completed');
    },
    onError: () => toast.error('Failed to complete task'),
  });

  const deleteTaskMutation = useMutation({
    mutationFn: (taskId: string) => deleteTask(taskId),
    onSuccess: () => {
      invalidate();
      toast.success('Task deleted');
    },
    onError: () => toast.error('Failed to delete task'),
  });

  const convertMutation = useMutation({
    mutationFn: (data: any) => convertLead(id!, data),
    onSuccess: () => {
      invalidate();
      convert.close();
      toast.success('Lead converted successfully!');
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || 'Failed to convert lead'),
  });

  const faxMutation = useMutation({
    mutationFn: (data: { to: string; file: File; header?: string }) => sendFax(data),
    onSuccess: () => {
      setFaxOpen(false);
      toast.success(t('fax.sent', 'Fax queued for delivery'));
    },
    onError: (err: any) => toast.error(err?.response?.data?.message || t('fax.sendFailed', 'Failed to send fax')),
  });

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const deleteMutation = useMutation({
    mutationFn: () => deleteLead(id!),
    onSuccess: () => {
      toast.success('Lead deleted');
      navigate('/leads');
    },
    onError: () => toast.error('Failed to delete lead'),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }
  // Distinguish a real 404 (lead deleted / wrong id) from a transient fetch
  // failure: the former is a terminal "not found", the latter deserves a retry
  // instead of falsely claiming the lead doesn't exist.
  const isNotFound = (error as any)?.response?.status === 404;
  if (isError && !isNotFound) {
    return (
      <div className="py-12 text-center">
        <Callout tone="danger" title="Could not load this lead." />
        <Button variant="outline" className="mt-3" onClick={() => refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (!lead) {
    return <div className="py-12 text-center text-muted-foreground">Lead not found</div>;
  }

  const canConvert = ['OFFER_SENT', 'WAITING'].includes(lead.status) && !lead.convertedTenantId;
  const sentOffers = (lead.offers || []).filter((o) => o.status === 'SENT');

  return (
    <div className="space-y-6">
      <PageHeader
        title={lead.businessName}
        description={lead.contactPerson}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <LeadStatusBadge status={lead.status} />
            {/* Status changes live HERE now (2026-07 trim) — one Select offering
                only the backend's LEGAL transitions for the current status,
                replacing the left-rail card of 8 pills where most were illegal
                moves that 400'd with a generic toast. WON stays owned by the
                /convert flow; a closed/converted lead gets no select at all. */}
            {!lead.convertedTenantId && STATUS_TRANSITIONS[lead.status]?.length > 0 && (
              <Select
                value="__current__"
                onValueChange={(s) => statusMutation.mutate(s)}
                disabled={statusMutation.isPending}
              >
                <SelectTrigger className="h-8 w-44" aria-label={t('leadDetail.changeStatus', 'Change status')}>
                  <SelectValue placeholder={t('leadDetail.changeStatus', 'Change status')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__current__" disabled>
                    {t('leadDetail.changeStatus', 'Change status')}
                  </SelectItem>
                  {STATUS_TRANSITIONS[lead.status].filter((s) => s !== 'WON').map((s) => (
                    <SelectItem key={s} value={s}>
                      {LEAD_STATUS_LABELS[s as keyof typeof LEAD_STATUS_LABELS] ?? s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {canConvert && (
              <Button
                variant="primary"
                size="sm"
                className="bg-success text-success-foreground hover:opacity-90"
                onClick={() => convert.open(lead, sentOffers)}
              >
                <CheckCircle2 className="h-4 w-4" /> Convert to Customer
              </Button>
            )}
            {/* Header-level assignment — THE one assignment surface (2026-07
                trim). AssignCell self-renders a read-only assignee label for
                non-managers, so it is safe un-gated. */}
            <div className="flex items-center gap-1 rounded-lg border border-border-strong px-3 py-1.5 text-sm hover:bg-surface-muted">
              <AssignCell
                leadId={lead.id}
                currentAssignee={lead.assignedTo ?? null}
                onAssigned={invalidate}
              />
            </div>
            {has('fax') && (
              <Button variant="outline" size="sm" onClick={() => setFaxOpen(true)}>
                <Printer className="h-4 w-4" /> {t('fax.action', 'Send fax')}
              </Button>
            )}
            <Button variant="outline" size="sm" asChild>
              <Link to={`/leads/${id}/edit`}>
                <Pencil className="h-4 w-4" /> Edit
              </Link>
            </Button>
            {isManager && (
              <Button
                variant="outline"
                size="sm"
                className="border-danger/40 text-danger hover:bg-danger-subtle"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            )}
          </div>
        }
      />

      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        tone="danger"
        title={t('leadDetail.deleteConfirm.title', 'Delete this lead?')}
        description={t('leadDetail.deleteConfirm.desc', 'The lead and its timeline are removed from your workspace. This cannot be undone.')}
        confirmLabel={t('common.delete', 'Delete')}
        cancelLabel={t('common.cancel', 'Cancel')}
        loading={deleteMutation.isPending}
        onConfirm={() => {
          setDeleteConfirmOpen(false);
          deleteMutation.mutate();
        }}
      />

      <Link
        to="/leads"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Leads
      </Link>

      {lead.convertedTenantId && (
        <Callout
          tone="success"
          title={`This lead has been converted to a customer on ${
            lead.convertedAt ? fmtDate(lead.convertedAt) : 'N/A'
          }.`}
        />
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left: Info */}
        <div className="lg:col-span-1 space-y-4">
          <ContactInfo lead={lead} fmtDate={fmtDate} />
          <CompanyPanel leadId={lead.id} companyId={lead.companyId} onUpdated={invalidate} />
          <WalletPanel leadId={lead.id} isManager={isManager} />
        </div>

        {/* Right: Tabs */}
        <div className="lg:col-span-2">
          <Tabs defaultValue="activities">
            <TabsList>
              <TabsTrigger value="activities">Activities</TabsTrigger>
              <TabsTrigger value="offers">Offers ({lead.offers?.length || 0})</TabsTrigger>
              <TabsTrigger value="tasks">Tasks ({lead.tasks?.length || 0})</TabsTrigger>
            </TabsList>

            <TabsContent value="activities">
              <ActivityTimelineTab
                leadId={lead.id}
                activities={lead.activities || []}
                onSubmit={(data) => activityMutation.mutate(data)}
                isPending={activityMutation.isPending}
              />
            </TabsContent>

            <TabsContent value="offers">
              <OffersTab
                leadId={lead.id}
                offers={lead.offers || []}
                converted={!!lead.convertedTenantId}
                fmtDate={fmtDate}
                onCreate={(data) => createOfferMutation.mutate(data)}
                createPending={createOfferMutation.isPending}
                onSend={(offerId) => sendOfferMutation.mutate(offerId)}
                onDelete={(offerId) => deleteOfferMutation.mutate(offerId)}
              />
            </TabsContent>

            <TabsContent value="tasks">
              <TasksTab
                leadId={lead.id}
                tasks={lead.tasks || []}
                fmtDate={fmtDate}
                onCreate={(data) => createTaskMutation.mutate(data)}
                createPending={createTaskMutation.isPending}
                onComplete={(taskId) => completeTaskMutation.mutate(taskId)}
                onDelete={(taskId) => deleteTaskMutation.mutate(taskId)}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <ConvertDialog
        state={convert}
        fmtDate={fmtDate}
        onSubmit={(data) => convertMutation.mutate(data)}
        isPending={convertMutation.isPending}
      />

      {has('fax') && (
        <SendFaxDialog
          open={faxOpen}
          onOpenChange={setFaxOpen}
          defaultTo={lead.phone ?? ''}
          onSubmit={(data) => faxMutation.mutate(data)}
          isPending={faxMutation.isPending}
        />
      )}
    </div>
  );
}
