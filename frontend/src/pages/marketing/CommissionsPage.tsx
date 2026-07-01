import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, DollarSign } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import type { Commission } from '../../features/marketing/types';
import { fmtDate } from '../../features/marketing/utils/format';
import { formatMoney, asWorkspaceCurrency } from '../../lib/money';
import CommissionDetailModal from '../../features/marketing/components/CommissionDetailModal';
import {
  PageHeader,
  Card,
  CardContent,
  StatCard,
  Badge,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  FilterBar,
  EmptyState,
  Skeleton,
  Button,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Input,
} from '../../components/ui';

// ─── helpers ─────────────────────────────────────────────────────────────────

function commissionStatusTone(
  status: string,
): 'warning' | 'info' | 'success' | 'neutral' {
  switch (status) {
    case 'PENDING':
      return 'warning';
    case 'APPROVED':
      return 'info';
    case 'PAID':
      return 'success';
    default:
      return 'neutral';
  }
}

// ─── Skeleton rows ─────────────────────────────────────────────────────────

function TableSkeleton({ cols }: { cols: number }) {
  return (
    <TBody>
      {Array.from({ length: 5 }).map((_, i) => (
        <TR key={i}>
          {Array.from({ length: cols }).map((__, j) => (
            <TD key={j}>
              <Skeleton className="h-4 w-full" />
            </TD>
          ))}
        </TR>
      ))}
    </TBody>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CommissionsPage() {
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';
  const queryClient = useQueryClient();

  const [period, setPeriod] = useState('');
  const [status, setStatus] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ── Queries ──────────────────────────────────────────────────────────────

  const {
    data: commissions,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['marketing', 'commissions', { period, status }],
    queryFn: () =>
      marketingApi
        .get('/commissions', {
          params: {
            period: period || undefined,
            status: status || undefined,
          },
        })
        .then((r) => r.data),
  });

  const { data: summary } = useQuery({
    queryKey: ['marketing', 'commissions', 'summary', { period, status }],
    queryFn: () =>
      marketingApi
        .get('/commissions/summary', {
          params: {
            period: period || undefined,
            status: status || undefined,
          },
        })
        .then((r) => r.data),
  });

  // ── Mutations ─────────────────────────────────────────────────────────────

  const approveMutation = useMutation({
    mutationFn: (id: string) => marketingApi.patch(`/commissions/${id}/approve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'commissions'] });
      toast.success('Commission approved');
    },
    onError: () => {
      toast.error('Failed to approve commission');
    },
  });

  const payMutation = useMutation({
    mutationFn: (id: string) => marketingApi.patch(`/commissions/${id}/pay`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['marketing', 'commissions'] });
      toast.success('Commission marked as paid');
    },
    onError: () => {
      toast.error('Failed to mark commission as paid');
    },
  });

  // ── Derived ───────────────────────────────────────────────────────────────

  const items: Commission[] = commissions?.data || [];
  const currency = asWorkspaceCurrency(summary?.currency);
  const colCount = isManager ? 7 : 6;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Commissions"
        description="Track and manage sales commissions across periods."
      />

      {/* Summary stat cards */}
      {summary && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard
            label="Pending"
            value={formatMoney(summary.pending.total, currency)}
            tone="warning"
            delta={{ value: `${summary.pending.count} entries`, direction: 'flat' }}
          />
          <StatCard
            label="Approved"
            value={formatMoney(summary.approved.total, currency)}
            tone="info"
            delta={{ value: `${summary.approved.count} entries`, direction: 'flat' }}
          />
          <StatCard
            label="Paid"
            value={formatMoney(summary.paid.total, currency)}
            tone="success"
            delta={{ value: `${summary.paid.count} entries`, direction: 'flat' }}
          />
        </div>
      )}

      {/* Filters */}
      <FilterBar>
        <div className="flex items-center gap-1.5">
          <label className="text-xs font-medium text-muted-foreground whitespace-nowrap">
            Period
          </label>
          <Input
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="h-9 w-40"
          />
        </div>
        <Select value={status || '__all'} onValueChange={(v) => setStatus(v === '__all' ? '' : v)}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">All statuses</SelectItem>
            <SelectItem value="PENDING">Pending</SelectItem>
            <SelectItem value="APPROVED">Approved</SelectItem>
            <SelectItem value="PAID">Paid</SelectItem>
          </SelectContent>
        </Select>
        {(period || status) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setPeriod('');
              setStatus('');
            }}
          >
            Clear
          </Button>
        )}
      </FilterBar>

      {/* Table */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Period</TH>
                <TH>Type</TH>
                <TH numeric>Amount</TH>
                <TH>Status</TH>
                <TH className="hidden md:table-cell">Rep</TH>
                <TH className="hidden md:table-cell">Date</TH>
                {isManager && <TH>Actions</TH>}
              </TR>
            </THead>

            {isLoading ? (
              <TableSkeleton cols={colCount} />
            ) : isError ? (
              <TBody>
                <TR>
                  <TD colSpan={colCount} className="py-12 text-center">
                    <p className="text-sm text-danger mb-2">Could not load commissions.</p>
                    <Button variant="outline" size="sm" onClick={() => refetch()}>
                      Retry
                    </Button>
                  </TD>
                </TR>
              </TBody>
            ) : items.length === 0 ? (
              <TBody>
                <TR>
                  <TD colSpan={colCount} className="py-0">
                    <EmptyState
                      title="No commissions found"
                      description="Adjust your filters or check back later."
                      className="rounded-none border-0"
                    />
                  </TD>
                </TR>
              </TBody>
            ) : (
              <TBody>
                {items.map((c) => (
                  <TR
                    key={c.id}
                    className="cursor-pointer"
                    onClick={() => setSelectedId(c.id)}
                  >
                    <TD className="font-medium text-foreground">{c.period}</TD>
                    <TD className="text-muted-foreground">{c.type}</TD>
                    <TD numeric className="font-medium">
                      {formatMoney(c.amount, currency)}
                    </TD>
                    <TD>
                      <Badge tone={commissionStatusTone(c.status)}>{c.status}</Badge>
                    </TD>
                    <TD className="hidden md:table-cell text-muted-foreground">
                      {c.marketingUser
                        ? `${c.marketingUser.firstName} ${c.marketingUser.lastName}`
                        : '—'}
                    </TD>
                    <TD className="hidden md:table-cell text-muted-foreground text-xs">
                      {fmtDate(c.createdAt)}
                    </TD>
                    {isManager && (
                      <TD onClick={(e) => e.stopPropagation()}>
                        <div className="flex gap-1">
                          {c.status === 'PENDING' && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => approveMutation.mutate(c.id)}
                              // Scope the in-flight guard to THIS commission — a
                              // bare approveMutation.isPending spins Approve on
                              // every other pending row while one runs.
                              loading={approveMutation.isPending && approveMutation.variables === c.id}
                            >
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Approve
                            </Button>
                          )}
                          {c.status === 'APPROVED' && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => payMutation.mutate(c.id)}
                              loading={payMutation.isPending && payMutation.variables === c.id}
                            >
                              <DollarSign className="h-3.5 w-3.5" />
                              Mark Paid
                            </Button>
                          )}
                        </div>
                      </TD>
                    )}
                  </TR>
                ))}
              </TBody>
            )}
          </Table>
        </CardContent>
      </Card>

      {/* Detail modal */}
      <CommissionDetailModal
        commissionId={selectedId}
        onClose={() => setSelectedId(null)}
        currency={currency}
      />
    </div>
  );
}
