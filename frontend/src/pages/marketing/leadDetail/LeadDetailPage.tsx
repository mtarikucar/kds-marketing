import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ArrowLeft, Pencil, Trash2, CheckCircle2 } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Spinner } from '@/components/ui/Spinner';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
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
import ActivityTimelineTab from './ActivityTimelineTab';
import OffersTab from './OffersTab';
import TasksTab from './TasksTab';
import ConvertDialog from './ConvertDialog';
import { useConvertDialog } from './useConvertDialog';

export default function LeadDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { i18n } = useTranslation('marketing');
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

  const convert = useConvertDialog();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'lead', id] });

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
            {/* Header-level assignment — primary discoverability point.
                Iki AssignCell instance ayni queryKey'leri paylasir,
                biri mutate ettiginde diger invalidate olur (no manual sync). */}
            {isManager && (
              <div className="flex items-center gap-1 rounded-lg border border-border-strong px-3 py-1.5 text-sm hover:bg-surface-muted">
                <AssignCell
                  leadId={lead.id}
                  currentAssignee={lead.assignedTo ?? null}
                  onAssigned={invalidate}
                />
              </div>
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
                onClick={() => {
                  if (window.confirm('Delete this lead?')) deleteMutation.mutate();
                }}
              >
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            )}
          </div>
        }
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
          <ContactInfo
            lead={lead}
            isManager={isManager}
            fmtDate={fmtDate}
            onAssigned={invalidate}
            onStatusChange={(s) => statusMutation.mutate(s)}
            statusPending={statusMutation.isPending}
          />
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
    </div>
  );
}
