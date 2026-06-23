import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import {
  InstallationStatus,
  INSTALLATION_STATUS_LABELS,
} from '../../../features/marketing/types';
import type {
  InstallationJob,
  InstallationCrew,
  Lead,
  PaginatedResponse,
} from '../../../features/marketing/types';
import { fmtDate } from '../../../features/marketing/utils/format';
import {
  Card,
  CardContent,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  FilterBar,
  Field,
  Input,
  Textarea,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  EmptyState,
  Skeleton,
  Pagination,
} from '../../../components/ui';
import { PhoneInput } from '../../../components/ui/PhoneInput';
import type { BadgeProps } from '../../../components/ui/Badge';

const STATUSES = Object.values(InstallationStatus);

const errMsg = (err: any, fallback: string) =>
  err?.response?.data?.message || fallback;

function statusTone(status: string): NonNullable<BadgeProps['tone']> {
  switch (status) {
    case 'REQUESTED':   return 'neutral';
    case 'SCHEDULED':   return 'info';
    case 'IN_PROGRESS': return 'warning';
    case 'DONE':        return 'success';
    case 'CANCELLED':   return 'danger';
    case 'NO_SHOW':     return 'danger';
    default:            return 'neutral';
  }
}

// ─── Job create schema ────────────────────────────────────────────────────────

const jobSchema = z.object({
  leadId: z.string().min(1, 'Select a converted customer'),
  contactName: z.string().optional(),
  contactPhone: z.string().optional(),
  siteCity: z.string().optional(),
  siteAddress: z.string().optional(),
  notes: z.string().optional(),
});
type JobFormValues = z.infer<typeof jobSchema>;

// ─── Skeleton rows ────────────────────────────────────────────────────────────

function TableSkeleton() {
  return (
    <TBody>
      {Array.from({ length: 5 }).map((_, i) => (
        <TR key={i}>
          {Array.from({ length: 5 }).map((__, j) => (
            <TD key={j}><Skeleton className="h-4 w-full" /></TD>
          ))}
        </TR>
      ))}
    </TBody>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  isManager: boolean;
  crews: InstallationCrew[];
  jobsData?: PaginatedResponse<InstallationJob>;
  jobsLoading: boolean;
  status: string;
  setStatus: (v: string) => void;
  crewIdFilter: string;
  setCrewIdFilter: (v: string) => void;
  page: number;
  setPage: (p: number) => void;
  convertedLeads: Lead[];
  onJobClick: (jobId: string) => void;
  onInvalidate: () => void;
}

export function JobsTab({
  isManager,
  crews,
  jobsData,
  jobsLoading,
  status,
  setStatus,
  crewIdFilter,
  setCrewIdFilter,
  page,
  setPage,
  convertedLeads,
  onJobClick,
  onInvalidate,
}: Props) {
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<JobFormValues>({
    resolver: zodResolver(jobSchema),
    defaultValues: {
      leadId: '',
      contactName: '',
      contactPhone: '',
      siteCity: '',
      siteAddress: '',
      notes: '',
    },
  });

  const createJob = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      marketingApi.post('/installations/jobs', payload),
    onSuccess: () => {
      toast.success('Installation job created');
      onInvalidate();
      setShowCreateDialog(false);
      reset();
    },
    onError: (e: any) => toast.error(errMsg(e, 'Failed to create job')),
  });

  function onSubmit(values: JobFormValues) {
    const lead = convertedLeads.find((l) => l.id === values.leadId);
    if (!lead?.convertedTenantId) {
      toast.error('Select a converted lead');
      return;
    }
    createJob.mutate({
      tenantId: lead.convertedTenantId,
      leadId: lead.id,
      siteAddress: values.siteAddress || undefined,
      siteCity: values.siteCity || undefined,
      contactName: values.contactName || undefined,
      contactPhone: values.contactPhone || undefined,
      notes: values.notes || undefined,
    });
  }

  const meta = jobsData?.meta;
  const jobs = jobsData?.data || [];
  const hasFilters = !!(status || crewIdFilter);

  return (
    <div className="space-y-4">
      {/* Filter bar + actions */}
      <FilterBar
        right={
          isManager ? (
            <Button size="sm" onClick={() => setShowCreateDialog(true)}>
              <Plus className="h-4 w-4" />
              New Job
            </Button>
          ) : undefined
        }
      >
        <Select
          value={status || '__all'}
          onValueChange={(v) => { setStatus(v === '__all' ? '' : v); setPage(1); }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">All statuses</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {INSTALLATION_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={crewIdFilter || '__all'}
          onValueChange={(v) => { setCrewIdFilter(v === '__all' ? '' : v); setPage(1); }}
        >
          <SelectTrigger className="w-36">
            <SelectValue placeholder="All crews" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">All crews</SelectItem>
            {crews.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setStatus(''); setCrewIdFilter(''); setPage(1); }}
          >
            Clear
          </Button>
        )}
      </FilterBar>

      {/* Jobs table */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Contact / Site</TH>
                <TH>Status</TH>
                <TH className="hidden md:table-cell">Crew</TH>
                <TH className="hidden md:table-cell">Scheduled</TH>
                <TH className="hidden lg:table-cell">Requested</TH>
              </TR>
            </THead>
            {jobsLoading ? (
              <TableSkeleton />
            ) : jobs.length === 0 ? (
              <TBody>
                <TR>
                  <TD colSpan={5} className="py-0">
                    <EmptyState
                      title="No jobs found"
                      description="Adjust the filters above or create a new job."
                      className="rounded-none border-0"
                    />
                  </TD>
                </TR>
              </TBody>
            ) : (
              <TBody>
                {jobs.map((j) => (
                  <TR
                    key={j.id}
                    className="cursor-pointer"
                    onClick={() => onJobClick(j.id)}
                  >
                    <TD>
                      <p className="font-medium text-foreground">{j.contactName || '—'}</p>
                      <p className="text-xs text-muted-foreground">
                        {j.siteCity || j.siteAddress || ''}
                      </p>
                    </TD>
                    <TD>
                      <Badge tone={statusTone(j.status)}>
                        {INSTALLATION_STATUS_LABELS[j.status as InstallationStatus] || j.status}
                      </Badge>
                    </TD>
                    <TD className="hidden md:table-cell text-muted-foreground">
                      {crews.find((c) => c.id === j.crewId)?.name || '—'}
                    </TD>
                    <TD className="hidden md:table-cell text-muted-foreground">
                      {j.scheduledDate ? fmtDate(j.scheduledDate) : '—'}
                    </TD>
                    <TD className="hidden lg:table-cell text-muted-foreground text-xs">
                      {fmtDate(j.requestedAt)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            )}
          </Table>
        </CardContent>
        {meta && meta.totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <p className="text-sm text-muted-foreground">
              {(meta.page - 1) * meta.limit + 1}–{Math.min(meta.page * meta.limit, meta.total)}{' '}
              of {meta.total}
            </p>
            <Pagination
              page={page}
              pageCount={meta.totalPages}
              onPage={setPage}
            />
          </div>
        )}
      </Card>

      {/* Create job dialog */}
      <Dialog
        open={showCreateDialog}
        onOpenChange={(open) => { if (!open) { setShowCreateDialog(false); reset(); } }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Installation Job</DialogTitle>
            <DialogDescription className="sr-only">Fill in the details to create a new installation job</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <Field
              label="Converted customer"
              error={errors.leadId?.message}
              required
            >
              {({ id, describedBy, invalid }) => (
                <select
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  {...register('leadId')}
                  className="h-9 w-full rounded-lg border border-border-strong bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-primary"
                >
                  <option value="">Select converted customer…</option>
                  {convertedLeads.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.businessName}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {convertedLeads.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No converted customers yet — jobs are created for leads that have a tenant.
              </p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Contact name" error={errors.contactName?.message}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    placeholder="Contact name"
                    {...register('contactName')}
                  />
                )}
              </Field>
              <Field label="Contact phone" error={errors.contactPhone?.message}>
                {({ id, describedBy, invalid }) => (
                  <PhoneInput
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    {...register('contactPhone')}
                  />
                )}
              </Field>
              <Field label="Site city" error={errors.siteCity?.message}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    placeholder="Site city"
                    {...register('siteCity')}
                  />
                )}
              </Field>
              <Field label="Site address" error={errors.siteAddress?.message}>
                {({ id, describedBy, invalid }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid || undefined}
                    placeholder="Site address"
                    {...register('siteAddress')}
                  />
                )}
              </Field>
            </div>
            <Field label="Notes" error={errors.notes?.message}>
              {({ id, describedBy, invalid }) => (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  placeholder="Notes"
                  rows={2}
                  {...register('notes')}
                />
              )}
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => { setShowCreateDialog(false); reset(); }}
              >
                Cancel
              </Button>
              <Button type="submit" loading={createJob.isPending}>
                Create Job
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
