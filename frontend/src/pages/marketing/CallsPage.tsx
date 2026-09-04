import { Fragment, lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Phone, PlayCircle, ChevronDown, ChevronRight } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { useMarketingAuthStore } from '../../store/marketingAuthStore';
import { useEntitlements } from '../../features/marketing/hooks/useEntitlements';
import { ClickToDialButton } from '../../features/marketing/components';
import CallAnalysisPanel from './calls/CallAnalysisPanel';
import CallRecordingPlayer from './calls/CallRecordingPlayer';
import QueueWallboard from './calls/QueueWallboard';
import { RouteFallback } from '../../components/RouteFallback';
import { CallStatus, CALL_STATUS_LABELS, MarketingRole } from '../../features/marketing/types';
import { FeatureGate, RoleGate } from '@/components/ui/access-gates';
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
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '../../components/ui';

// Lazy so the dialer's code only loads when its tab is opened.
const DialerPage = lazy(() => import('./DialerPage'));
// Same reason, and one more: the AI-call transcript view is behind two gates
// most workspaces do not pass, so its chunk must not ride along on /calls.
const VoicePage = lazy(() => import('./VoicePage'));

/**
 * The three tabs of the calls hub.
 *
 * EXPORTED because `?tab=` is read by THREE pages now — InboxPage's config
 * surfaces, TasksPage's filters, and this one — and the three vocabularies not
 * colliding is a coincidence rather than a design. `tabParam.contract.test.ts`
 * imports all three lists and fails the moment any two overlap.
 *
 * `voice` is the third value as of 2026-09-01: `/voice` is a route whose whole
 * subject is calls the AI answered, and reading it meant leaving the call log
 * for a settings-area page. It is merged in as a TAB, gates and all — see the
 * branch below — rather than linked to.
 */
export const CALLS_TABS = ['calls', 'dialer', 'voice'] as const;
type CallsPageTab = (typeof CALLS_TABS)[number];

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

export interface CallsPageProps {
  /** Hosted inside another screen: no <h1> of its own, and no URL of its own. */
  embedded?: boolean;
  /**
   * Drop the header ENTIRELY — action and description included.
   *
   * `embedded` means "something else owns the page title", which is what a tab
   * of Voice wants: it still needs Click-to-dial and the one line explaining the
   * single-line rule. The person surface's left column wants neither — it is
   * narrow, the dialer is already on screen, and prose there pushes the rows
   * somebody came to read off the top. Two hosts, two answers, said explicitly
   * rather than inferred from a prop that means something else.
   */
  headerless?: boolean;
  /** Who the host is showing; only used to light the matching row. */
  selectedLeadId?: string | null;
  /** A SELECTION handed up to the host — never a navigation. */
  onSelectPerson?: (p: { id: string; phone?: string | null }) => void;
}

/**
 * Calls hub — the call log, the Power Dialer and the AI-answered calls as
 * URL-synced (`?tab=`) deep-linkable tabs, so every view survives refresh/back
 * and can be shared.
 *
 * ## Why `embedded` drops the URL rather than keeping it
 *
 * The Inbox mounts this page as its fifth left arrangement, where it shares ONE
 * url with InboxPage (`?tab=` = a config surface) and TasksPage (`?tab=` = a
 * task filter). Three owners for one parameter is not deep-linkability, it is a
 * race: the left column writing `?tab=dialer` hands InboxPage and TasksPage a
 * value each of them falls back on, and the surface silently rearranges around
 * a click that was about the call log. So while embedded the tab is local
 * state and this page writes NO parameter at all — the same call
 * `PeopleColumn` already makes about `?create=1`.
 */
export default function CallsPage({ embedded, headerless, selectedLeadId, onSelectPerson }: CallsPageProps = {}) {
  const { t } = useTranslation('marketing');
  const [params, setParams] = useSearchParams();
  const [localTab, setLocalTab] = useState<CallsPageTab>('calls');
  const raw = params.get('tab');
  const urlTab: CallsPageTab = (CALLS_TABS as readonly string[]).includes(raw ?? '')
    ? (raw as CallsPageTab)
    : 'calls';
  const tab = embedded ? localTab : urlTab;
  const setTab = (v: string) => {
    if (embedded) {
      setLocalTab(v as CallsPageTab);
      return;
    }
    setParams((p) => {
      p.set('tab', v);
      return p;
    }, { replace: true });
  };

  return (
    <div className="space-y-6">
      {/* Two hosts embed this page and they want different things. As a TAB of
          Voice it keeps its action and its one-line explanation, like every
          other merged tab. As the left COLUMN of the person surface it wants
          neither: the column is narrow, the dialer is already on the screen,
          and a paragraph of prose there is noise pushed above the rows somebody
          came to read. `headerless` is the column saying so, rather than the
          page guessing from a prop that means something else. */}
      {!headerless && (
        <PageHeader
          embedded={embedded}
          title="Sales Calls"
          description="Single company line — one active call at a time. Your softphone opens via the tel: link; log the outcome when the call ends."
          actions={<ClickToDialButton />}
        />
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="calls">{t('calls.tab.calls', 'Calls')}</TabsTrigger>
          <TabsTrigger value="dialer">{t('calls.tab.dialer', 'Power Dialer')}</TabsTrigger>
          {/* The tab appears with its gates, or it does not appear. navigation.ts
              gives /voice `feature: 'voiceAi'` + `managerOnly`, mirroring
              VoiceAiController — merging the page in here may not be a
              permission change, so the same pair travels with it. Both fail
              CLOSED while /billing/summary is in flight. */}
          <FeatureGate feature="voiceAi">
            <RoleGate role={MarketingRole.MANAGER}>
              <TabsTrigger value="voice">
                {t('calls.tab.voice', 'Yapay zekâ görüşmeleri')}
              </TabsTrigger>
            </RoleGate>
          </FeatureGate>
        </TabsList>

        <TabsContent value="calls" className="pt-5">
          <CallsTab
            embedded={embedded}
            selectedLeadId={selectedLeadId}
            onSelectPerson={onSelectPerson}
          />
        </TabsContent>
        <TabsContent value="dialer" className="pt-5">
          <Suspense fallback={<RouteFallback />}>
            <DialerPage embedded />
          </Suspense>
        </TabsContent>
        <TabsContent value="voice" className="pt-5">
          <FeatureGate feature="voiceAi">
            <RoleGate role={MarketingRole.MANAGER}>
              <Suspense fallback={<RouteFallback />}>
                <VoicePage embedded />
              </Suspense>
            </RoleGate>
          </FeatureGate>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Static hint only (no cross-origin link) — the actual in-app player lives in
 *  the expanded detail panel, fetched via the workspace-scoped recording route. */
function RecordingHint({ title }: { title: string }) {
  return (
    <span title={title}>
      <PlayCircle className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
    </span>
  );
}

// ─── Calls tab (the original call log) ───────────────────────────────────────

function CallsTab({ embedded, selectedLeadId, onSelectPerson }: CallsPageProps) {
  const { t } = useTranslation('marketing');
  const { user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';
  // Wallboard hits telephony-only routes that 503 without an active Netsantral
  // config — only render it for workspaces the package actually entitles.
  const { has: hasFeature } = useEntitlements();
  const showWallboard = hasFeature('telephony');

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

  const repName = (id: string | null) => {
    const r = id ? reps.find((x) => x.id === id) : undefined;
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

  /**
   * Three of the seven columns are dropped when this table is a ~34% column of
   * somebody else's screen: Duration, Rep and Started already hide below `md`
   * and `lg`, and those breakpoints read the VIEWPORT, so on a wide monitor
   * they all stay on and the number a rep came for is off the right edge. Notes
   * goes with them — a truncated note is not a note.
   */
  const wide = !embedded;
  // Column count: toggle, To, Status, [Duration], [Rep], [Started], [Notes]
  const colCount = 3 + (wide ? (isManager ? 4 : 3) : 0);

  return (
    <div className="space-y-6">
      {showWallboard && <QueueWallboard />}

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
                {wide && <TH className="hidden md:table-cell">Duration</TH>}
                {wide && isManager && <TH className="hidden md:table-cell">Rep</TH>}
                {wide && <TH className="hidden lg:table-cell">Started</TH>}
                {wide && <TH className="hidden lg:table-cell">Notes</TH>}
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
                      {/* A SELECTION, never a navigation — the same contract
                          every other arrangement of the person surface has.
                          Only when the call actually MATCHED somebody:
                          `leadId` is nullable (an inbound call from a number no
                          lead carries has nobody to hand over), and a button
                          that selects nothing is worse than plain text. */}
                      {onSelectPerson && c.leadId ? (
                        <button
                          type="button"
                          data-testid={`call-row-person-${c.id}`}
                          aria-pressed={selectedLeadId === c.leadId}
                          onClick={(e) => {
                            // The row itself toggles the analysis panel; this
                            // click is about the person, not about the detail.
                            e.stopPropagation();
                            onSelectPerson({ id: c.leadId as string, phone: c.toPhone });
                          }}
                          className="inline-flex items-center gap-1.5 text-start hover:underline"
                        >
                          {c.toPhone}
                          {c.recordingUrl && <RecordingHint title={t('callRecording.title', 'Recording')} />}
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          {c.toPhone}
                          {c.recordingUrl && <RecordingHint title={t('callRecording.title', 'Recording')} />}
                        </span>
                      )}
                    </TD>
                    <TD>
                      <Badge tone={CALL_STATUS_TONE[c.status] ?? 'neutral'}>
                        {CALL_STATUS_LABELS[c.status] || c.status}
                      </Badge>
                    </TD>
                    {wide && (
                      <TD className="hidden md:table-cell text-muted-foreground">
                        {fmtDuration(c.durationSec)}
                      </TD>
                    )}
                    {wide && isManager && (
                      <TD className="hidden md:table-cell text-muted-foreground">
                        {repName(c.marketingUserId)}
                      </TD>
                    )}
                    {wide && (
                      <TD className="hidden lg:table-cell text-muted-foreground text-xs">
                        {fmtDateTime(c.startedAt)}
                      </TD>
                    )}
                    {wide && (
                      <TD className="hidden lg:table-cell text-muted-foreground text-xs max-w-xs truncate">
                        {c.notes || '—'}
                      </TD>
                    )}
                  </TR>
                  {expandedId === c.id && (
                    <TR>
                      <TD colSpan={colCount} className="bg-surface-muted/40">
                        <div className="px-2">
                          {c.recordingUrl && <CallRecordingPlayer callId={c.id} />}
                          <p className="text-caption font-medium text-foreground">
                            {t('callAnalysis.title', 'Call analysis')}
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
