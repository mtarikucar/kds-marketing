import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Phone, PlayCircle, ChevronDown, ChevronRight } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import { ClickToDialButton } from '../../features/marketing/components';
import CallAnalysisPanel from './calls/CallAnalysisPanel';
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
  QueryStateBoundary,
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
  const { t } = useTranslation('marketing');
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  const [status, setStatus] = useState('');
  const [repId, setRepId] = useState('');
  const [page, setPage] = useState(1);
  // Which call row is expanded to show its AI analysis panel.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery<PaginatedResponse<SalesCall>>({
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

  // Column count: toggle, To, Status, Duration, [Rep], Started, Notes
  const colCount = isManager ? 7 : 6;

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
          value={status || '__all__'}
          onValueChange={(v) => {
            setStatus(v === '__all__' ? '' : v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All statuses</SelectItem>
            {CALL_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {CALL_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isManager && (
          <Select
            value={repId || '__all__'}
            onValueChange={(v) => {
              setRepId(v === '__all__' ? '' : v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-44">
              <SelectValue placeholder="All reps" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All reps</SelectItem>
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

      {/* ── Error state ── */}
      <QueryStateBoundary
        isError={isError}
        onRetry={() => refetch()}
        errorMessage={t('common.loadError', 'Could not load. Please try again.')}
      />

      {/* ── Table ── */}
      {!isError && (
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH className="w-8" />
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
                  <Fragment key={c.id}>
                  <TR
                    className="cursor-pointer"
                    onClick={() => setExpandedId((id) => (id === c.id ? null : c.id))}
                  >
                    <TD className="text-muted-foreground">
                      {expandedId === c.id ? (
                        <ChevronDown className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="h-4 w-4" aria-hidden="true" />
                      )}
                    </TD>
                    <TD className="font-medium text-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        {c.toPhone}
                        {c.recordingUrl && (
                          <a
                            href={c.recordingUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Play recording"
                            className="text-primary hover:text-primary/80"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <PlayCircle className="h-4 w-4" aria-hidden="true" />
                            <span className="sr-only">Play recording</span>
                          </a>
                        )}
                      </span>
                    </TD>
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
                  {expandedId === c.id && (
                    <TR>
                      <TD colSpan={colCount} className="bg-surface-muted/40">
                        <div className="px-2">
                          <p className="text-caption font-medium text-foreground">
                            {t('callAnalysis.title', 'Görüşme analizi')}
                          </p>
                          <CallAnalysisPanel
                            callId={c.id}
                            hasRecording={!!c.recordingUrl}
                          />
                        </div>
                      </TD>
                    </TR>
                  )}
                  </Fragment>
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
      )}
    </div>
  );
}
