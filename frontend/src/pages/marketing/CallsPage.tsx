import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Phone } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import { ClickToDialButton } from '../../features/marketing/components';
import { CallStatus, CALL_STATUS_LABELS } from '../../features/marketing/types';
import type { SalesCall, PaginatedResponse, MarketingUserInfo } from '../../features/marketing/types';
import { fmtDateTime, fmtDuration } from '../../features/marketing/utils/format';
import {
  PageHeader,
  Card,
  CardContent,
  FilterBar,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Badge,
  type BadgeProps,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Skeleton,
  EmptyState,
  Pagination,
  Button,
} from '../../components/ui';

// ─── helpers ─────────────────────────────────────────────────────────────────

interface RepRow extends MarketingUserInfo {
  role: string;
}

const CALL_STATUSES = Object.values(CallStatus);

/** Map call statuses to Console Badge tones. */
const CALL_STATUS_TONE: Record<string, BadgeProps['tone']> = {
  INITIATED: 'info',
  CONNECTED: 'success',
  NO_ANSWER: 'warning',
  BUSY: 'warning',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

// ─── Skeleton rows ────────────────────────────────────────────────────────────

function TableSkeleton({ cols, rows = 8 }: { cols: number; rows?: number }) {
  return (
    <TBody>
      {Array.from({ length: rows }).map((_, i) => (
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

// ─── Page ────────────────────────────────────────────────────────────────────

export default function CallsPage() {
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  const [status, setStatus] = useState('');
  const [repId, setRepId] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery<PaginatedResponse<SalesCall>>({
    queryKey: ['marketing', 'calls', { status, repId, page }],
    queryFn: () =>
      marketingApi
        .get('/calls', {
          params: {
            status: status || undefined,
            marketingUserId: repId || undefined,
            page,
            limit: 20,
          },
        })
        .then((r) => r.data),
  });

  const { data: reps = [] } = useQuery<RepRow[]>({
    queryKey: ['marketing', 'users'],
    queryFn: () => marketingApi.get('/users').then((r) => r.data),
    enabled: isManager,
    staleTime: 60_000,
  });

  const repName = (id: string) => {
    const r = reps.find((x) => x.id === id);
    return r ? `${r.firstName} ${r.lastName}` : '—';
  };

  const meta = data?.meta;
  const calls = data?.data ?? [];
  const repOptions = reps.filter((r) => r.role === 'REP');
  const hasFilters = !!(status || repId);

  const clearFilters = () => {
    setStatus('');
    setRepId('');
    setPage(1);
  };

  // Column count: To, Status, Duration, [Rep], Started, Notes
  const colCount = isManager ? 6 : 5;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales Calls"
        description="Single company line — one active call at a time. Your softphone opens via the tel: link; log the outcome when the call ends."
        actions={<ClickToDialButton />}
      />

      {/* ── Filters ── */}
      <FilterBar>
        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">All statuses</SelectItem>
            {CALL_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {CALL_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isManager && (
          <Select
            value={repId}
            onValueChange={(v) => {
              setRepId(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-44">
              <SelectValue placeholder="All reps" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">All reps</SelectItem>
              {repOptions.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.firstName} {r.lastName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </FilterBar>

      {/* ── Table ── */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>To</TH>
                <TH>Status</TH>
                <TH className="hidden md:table-cell">Duration</TH>
                {isManager && <TH className="hidden md:table-cell">Rep</TH>}
                <TH className="hidden lg:table-cell">Started</TH>
                <TH className="hidden lg:table-cell">Notes</TH>
              </TR>
            </THead>

            {isLoading ? (
              <TableSkeleton cols={colCount} />
            ) : calls.length === 0 ? null : (
              <TBody>
                {calls.map((c) => (
                  <TR key={c.id}>
                    <TD className="font-medium text-foreground">{c.toPhone}</TD>
                    <TD>
                      <Badge tone={CALL_STATUS_TONE[c.status] ?? 'neutral'}>
                        {CALL_STATUS_LABELS[c.status] || c.status}
                      </Badge>
                    </TD>
                    <TD className="hidden md:table-cell text-muted-foreground">
                      {fmtDuration(c.durationSec)}
                    </TD>
                    {isManager && (
                      <TD className="hidden md:table-cell text-muted-foreground">
                        {repName(c.marketingUserId)}
                      </TD>
                    )}
                    <TD className="hidden lg:table-cell text-muted-foreground text-xs">
                      {fmtDateTime(c.startedAt)}
                    </TD>
                    <TD className="hidden lg:table-cell text-muted-foreground text-xs max-w-xs truncate">
                      {c.notes || '—'}
                    </TD>
                  </TR>
                ))}
              </TBody>
            )}
          </Table>

          {!isLoading && calls.length === 0 && (
            <EmptyState
              icon={<Phone className="h-10 w-10" />}
              title={hasFilters ? 'No calls match your filters' : 'No calls yet'}
              description={
                hasFilters
                  ? 'Try adjusting your filters to find calls.'
                  : 'Calls will appear here once your team starts dialling.'
              }
              action={
                hasFilters ? (
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : undefined
              }
              className="m-4"
            />
          )}
        </CardContent>

        {/* ── Pagination ── */}
        {meta && meta.totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <p className="text-sm text-muted-foreground">
              {(meta.page - 1) * meta.limit + 1}–{Math.min(meta.page * meta.limit, meta.total)}{' '}
              of {meta.total}
            </p>
            <Pagination page={page} pageCount={meta.totalPages} onPage={setPage} />
          </div>
        )}
      </Card>
    </div>
  );
}
