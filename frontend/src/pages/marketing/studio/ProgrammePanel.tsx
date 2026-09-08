import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarRange, ChevronDown, ChevronUp, Info, Ban, Pencil, RefreshCw, SkipForward } from 'lucide-react';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Progress, type ProgressTone } from '@/components/ui/Progress';
import { Skeleton } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { Table, TBody, TD, TH, THead, TR } from '@/components/ui/Table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/Tooltip';
import { cn } from '@/components/ui/cn';
import {
  getProgramme,
  killProgramme,
  pauseProgramme,
  programmeKeys,
  regenerateSlot,
  resumeProgramme,
  skipSlot,
  slotMetrics,
  updateSlot,
  type Dashboard,
  type ContentProgramme,
  type SlotPatch,
  type SlotView,
} from '../../../features/marketing/api/contentProgramme.service';
import { EventLog } from './programme/EventLog';
import { LearningPanel, PHASE_TONE, usePhaseLabels } from './programme/LearningPanel';
import { ProgrammeSetupDialog } from './programme/ProgrammeSetupDialog';
import { SlotEditor, errorMessage, hoursLeft } from './programme/SlotEditor';
import { SlotStrip, statusGlyph, typeColour } from './programme/SlotStrip';
import { TrendFeed } from './programme/TrendFeed';
import { TypesTable } from './programme/TypesTable';

/**
 * THE PROGRAMME, on the Studio's one screen.
 *
 * The owner's brief for this feature ended with "her şey Studio'nun tek
 * ekranından, kompakt bir panelden yönetilsin" — so this is one row, always
 * visible, that answers the four questions an autonomous loop raises (is it
 * running, what phase is it in, how much of this week's credit is gone, what
 * is going out over the next two weeks) and puts the switches next to the
 * answers. Everything with more than a line to say sits behind "Ayrıntı" as
 * tabs, and the tabs are the only place tabs appear: `StudioOneScreen`'s test
 * asserts no `role="tab"` on the collapsed screen, on purpose.
 *
 * ## One query draws the whole default view
 *
 * `GET /content-programme` returns the programme AND a dashboard that already
 * carries the slot window, the types, the learning table, the trends and the
 * last 30 events. So the row, the strip and every tab render from the same
 * `['content-programme']` entry, and every mutation invalidates that prefix:
 * a slot edit moves a chip, changes a type's planned share and adds an event,
 * and enumerating which keys to refresh is how one tab ends up describing
 * yesterday. The only other query is per-slot metrics, fetched when a row
 * is opened, because it walks the post → target → metric chain server-side
 * and is not worth paying for on rows nobody expands.
 *
 * ## No approval, and it says so
 *
 * The loop is autonomous by design (K3): nothing here is a "review" button.
 * What the owner has instead is an EDIT WINDOW per slot, and the editor
 * prints how much of it is left rather than hiding the fields when it closes.
 */
export interface ProgrammePanelProps {
  className?: string;
  /** Reference clock. Read once at mount so every chip agrees on "now". */
  now?: Date;
}

const STATUS_TONE: Record<string, BadgeProps['tone']> = {
  ACTIVE: 'success',
  PAUSED: 'warning',
  KILLED: 'danger',
};

type Tab = 'slots' | 'types' | 'learning' | 'trends' | 'events';

export function ProgrammePanel({ className, now: nowProp }: ProgrammePanelProps) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [now] = useState(() => nowProp ?? new Date());
  const [setupOpen, setSetupOpen] = useState(false);
  const [killOpen, setKillOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<Tab>('slots');
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [metricsSlot, setMetricsSlot] = useState<string | null>(null);

  // `meta.silent`: main.tsx toasts every non-401 query failure globally and
  // this panel has an inline error line of its own — see AutopilotStatusBar.
  const q = useQuery({ queryKey: programmeKeys.root, queryFn: getProgramme, meta: { silent: true } });
  const invalidate = () => qc.invalidateQueries({ queryKey: programmeKeys.root });
  const fail = (fallback: string) => (e: unknown) => toast.error(errorMessage(e, fallback));

  const programme = q.data?.programme ?? null;
  const dashboard = q.data?.dashboard ?? null;

  const running = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => (on ? resumeProgramme(id) : pauseProgramme(id)),
    onSuccess: invalidate,
    onError: fail(t('studio.programme.row.toggleFailed', 'Program durumu değiştirilemedi.')),
  });
  const kill = useMutation({
    mutationFn: (id: string) => killProgramme(id),
    onSuccess: () => {
      invalidate();
      setKillOpen(false);
      toast.success(t('studio.programme.row.killed', 'Program durduruldu; açık slotlar iptal edildi.'));
    },
    onError: fail(t('studio.programme.row.killFailed', 'Program durdurulamadı.')),
  });
  const save = useMutation({
    mutationFn: ({ id, slotId, patch }: { id: string; slotId: string; patch: SlotPatch }) => updateSlot(id, slotId, patch),
    onSuccess: () => {
      invalidate();
      toast.success(t('studio.programme.editor.saved', 'Slot güncellendi.'));
    },
    onError: fail(t('studio.programme.editor.saveFailed', 'Slot kaydedilemedi.')),
  });
  const skip = useMutation({
    mutationFn: ({ id, slotId }: { id: string; slotId: string }) => skipSlot(id, slotId),
    onSuccess: () => {
      invalidate();
      setSelectedSlot(null);
    },
    onError: fail(t('studio.programme.editor.skipFailed', 'Slot atlanamadı.')),
  });
  const regenerate = useMutation({
    mutationFn: ({ id, slotId }: { id: string; slotId: string }) => regenerateSlot(id, slotId),
    onSuccess: () => {
      invalidate();
      toast.success(t('studio.programme.editor.regenerated', 'Slot yeniden planlanıyor.'));
    },
    onError: fail(t('studio.programme.editor.regenerateFailed', 'Slot yeniden üretilemedi.')),
  });

  const shell = (children: React.ReactNode) => (
    <TooltipProvider delayDuration={200}>
      <div className={cn('flex flex-col gap-3 px-4 py-2.5', className)}>{children}</div>
    </TooltipProvider>
  );

  if (q.isError && q.data === undefined) {
    return shell(
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-danger">{t('studio.programme.error', 'İçerik programı okunamadı.')}</span>
        <Button variant="outline" size="sm" onClick={() => q.refetch()}>
          {t('common.retry', 'Yeniden dene')}
        </Button>
      </div>,
    );
  }

  if (q.isLoading) {
    return shell(
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-6 flex-1" />
      </div>,
    );
  }

  if (!programme || !dashboard) {
    return shell(
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <CalendarRange className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t('studio.programme.title', 'İçerik programı')}
        </span>
        <span className="text-sm text-muted-foreground">
          {t(
            'studio.programme.none',
            'Henüz program yok: türlere göre üretip yayınlayan ve tutan türlere kayan döngü burada başlar.',
          )}
        </span>
        <Button size="sm" className="ms-auto" onClick={() => setSetupOpen(true)}>
          {t('studio.programme.start', 'Programı başlat')}
        </Button>
        <ProgrammeSetupDialog open={setupOpen} onOpenChange={setSetupOpen} />
      </div>,
    );
  }

  const selected = dashboard.slots.find((s) => s.id === selectedSlot) ?? null;
  const busy = save.isPending || skip.isPending || regenerate.isPending;
  const openMetrics = (slotId: string) => {
    setExpanded(true);
    setTab('slots');
    setMetricsSlot(slotId);
  };

  return shell(
    <>
      <CompactRow
        programme={programme}
        dashboard={dashboard}
        stale={q.isError}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((e) => !e)}
        onRunning={(on) => running.mutate({ id: programme.id, on })}
        runningPending={running.isPending}
        onKill={() => setKillOpen(true)}
        now={now}
        selectedSlot={selectedSlot}
        onSelectSlot={(id) => setSelectedSlot((cur) => (cur === id ? null : id))}
      />

      {selected && (
        <SlotEditor
          slot={selected}
          types={dashboard.types}
          now={now}
          busy={busy}
          onSave={(patch) => save.mutate({ id: programme.id, slotId: selected.id, patch })}
          onSkip={() => skip.mutate({ id: programme.id, slotId: selected.id })}
          onRegenerate={() => regenerate.mutate({ id: programme.id, slotId: selected.id })}
          onMetrics={() => openMetrics(selected.id)}
          onClose={() => setSelectedSlot(null)}
        />
      )}

      {expanded && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} data-testid="programme-detail">
          <TabsList>
            <TabsTrigger value="slots">{t('studio.programme.tabs.slots', 'Slotlar')}</TabsTrigger>
            <TabsTrigger value="types">{t('studio.programme.tabs.types', 'Türler')}</TabsTrigger>
            <TabsTrigger value="learning">{t('studio.programme.tabs.learning', 'Öğrenme')}</TabsTrigger>
            <TabsTrigger value="trends">{t('studio.programme.tabs.trends', 'Trendler')}</TabsTrigger>
            <TabsTrigger value="events">{t('studio.programme.tabs.events', 'Günlük')}</TabsTrigger>
          </TabsList>
          <TabsContent value="slots">
            <SlotsTable
              programmeId={programme.id}
              slots={dashboard.slots}
              now={now}
              busy={busy}
              openMetrics={metricsSlot}
              onToggleMetrics={(id) => setMetricsSlot((cur) => (cur === id ? null : id))}
              onEdit={(id) => setSelectedSlot(id)}
              onSkip={(id) => skip.mutate({ id: programme.id, slotId: id })}
              onRegenerate={(id) => regenerate.mutate({ id: programme.id, slotId: id })}
            />
          </TabsContent>
          <TabsContent value="types">
            <TypesTable programmeId={programme.id} types={dashboard.types} />
          </TabsContent>
          <TabsContent value="learning">
            <LearningPanel learning={dashboard.learning} types={dashboard.types} />
          </TabsContent>
          <TabsContent value="trends">
            <TrendFeed trends={dashboard.trends} />
          </TabsContent>
          <TabsContent value="events">
            <EventLog events={dashboard.events} now={now} />
          </TabsContent>
        </Tabs>
      )}

      <ConfirmDialog
        open={killOpen}
        onOpenChange={setKillOpen}
        tone="danger"
        title={t('studio.programme.kill.title', 'Programı durdur (kill)?')}
        description={t(
          'studio.programme.kill.description',
          'Geri alınamaz: açık slotlar iptal edilir, kampanya duraklatılır, geçmiş ve öğrenilenler kalır. Yeni bir program açmak için baştan kurmanız gerekir.',
        )}
        confirmLabel={t('studio.programme.kill.confirm', 'Evet, durdur')}
        cancelLabel={t('common.cancel', 'Vazgeç')}
        loading={kill.isPending}
        onConfirm={() => kill.mutate(programme.id)}
      />
    </>,
  );
}

/* ------------------------------------------------------------------------ */

interface CompactRowProps {
  programme: ContentProgramme;
  dashboard: Dashboard;
  stale: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onRunning: (on: boolean) => void;
  runningPending: boolean;
  onKill: () => void;
  now: Date;
  selectedSlot: string | null;
  onSelectSlot: (id: string) => void;
}

function CompactRow({
  programme,
  dashboard,
  stale,
  expanded,
  onToggleExpanded,
  onRunning,
  runningPending,
  onKill,
  now,
  selectedSlot,
  onSelectSlot,
}: CompactRowProps) {
  const { t } = useTranslation('marketing');
  const { label: phaseLabel, explain } = usePhaseLabels();

  // `killSwitch` and `status` are two fields; a KILLED status or a raised
  // switch both mean "stopped", and the badge must never print ACTIVE over one.
  const status = dashboard.killSwitch ? 'KILLED' : dashboard.status;
  const statusLabel: Record<string, string> = {
    ACTIVE: t('studio.programme.status.ACTIVE', 'Çalışıyor'),
    PAUSED: t('studio.programme.status.PAUSED', 'Duraklatıldı'),
    KILLED: t('studio.programme.status.KILLED', 'Durduruldu'),
  };
  const dead = status === 'KILLED';
  const { spent, cap } = dashboard.week;
  const ratio = cap > 0 ? spent / cap : 0;
  const tone: ProgressTone = ratio >= 1 ? 'danger' : ratio >= 0.8 ? 'warning' : 'primary';

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="programme-row">
      <span className="flex items-center gap-2 text-sm font-medium text-foreground">
        <CalendarRange className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="max-w-[12rem] truncate" title={programme.name}>
          {programme.name}
        </span>
      </span>

      <Badge tone={STATUS_TONE[status] ?? 'neutral'} data-testid="programme-status">
        {statusLabel[status] ?? status}
      </Badge>

      <Tooltip>
        <TooltipTrigger asChild>
          <Badge tone={PHASE_TONE[dashboard.phase] ?? 'neutral'} data-testid="programme-phase" className="cursor-help gap-1">
            {phaseLabel(dashboard.phase)}
            <Info className="h-3 w-3" aria-hidden="true" />
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{explain(dashboard.phase)}</TooltipContent>
      </Tooltip>

      {stale && (
        <span className="text-xs text-warning" data-testid="programme-stale">
          {t('studio.programme.stale', 'durum güncellenemedi')}
        </span>
      )}

      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={status === 'ACTIVE'}
          disabled={dead || runningPending}
          onCheckedChange={onRunning}
          aria-label={t('studio.programme.row.running', 'Çalışıyor')}
          data-testid="programme-running"
        />
        <span className="text-muted-foreground">{t('studio.programme.row.running', 'Çalışıyor')}</span>
      </label>

      <Button variant="destructive" size="sm" className="h-7 px-2 text-xs" disabled={dead} onClick={onKill}>
        <Ban className="me-1 h-3.5 w-3.5" aria-hidden="true" />
        {t('studio.programme.row.kill', 'Durdur (kill)')}
      </Button>

      <div className="flex min-w-[10rem] flex-col gap-1" data-testid="programme-burn">
        <span className="text-micro uppercase tracking-wide text-muted-foreground">
          {t('studio.programme.row.burn', '{{spent}}/{{cap}} kredi bu hafta', { spent, cap })}
        </span>
        <Progress value={ratio * 100} tone={tone} className="h-1.5" />
      </div>

      <SlotStrip slots={dashboard.slots} selectedId={selectedSlot} onSelect={onSelectSlot} now={now} className="flex-1" />

      <Button variant="ghost" size="sm" className="ms-auto" aria-expanded={expanded} onClick={onToggleExpanded}>
        {expanded ? <ChevronUp className="me-1 h-4 w-4" aria-hidden="true" /> : <ChevronDown className="me-1 h-4 w-4" aria-hidden="true" />}
        {t('studio.programme.row.detail', 'Ayrıntı')}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------------ */

interface SlotsTableProps {
  programmeId: string;
  slots: SlotView[];
  now: Date;
  busy: boolean;
  openMetrics: string | null;
  onToggleMetrics: (id: string) => void;
  onEdit: (id: string) => void;
  onSkip: (id: string) => void;
  onRegenerate: (id: string) => void;
}

const SLOT_TONE: Record<string, BadgeProps['tone']> = {
  PLANNED: 'neutral',
  IDEATED: 'info',
  PRODUCING: 'info',
  READY: 'primary',
  PUBLISHED: 'success',
  MEASURED: 'success',
  SKIPPED: 'neutral',
  FAILED: 'danger',
};

/**
 * Every slot in the dashboard window (yesterday to the lookahead), soonest
 * first, with the numbers the strip's chips have no room for. A row opens
 * into its metrics; the edit action hands the slot to the same inline editor
 * the chips use, so there is exactly one place a slot is changed.
 */
function SlotsTable({ programmeId, slots, now, busy, openMetrics, onToggleMetrics, onEdit, onSkip, onRegenerate }: SlotsTableProps) {
  const { t, i18n } = useTranslation('marketing');
  const rows = [...slots].sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));

  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">{t('studio.programme.slots.empty', 'Bu pencerede slot yok.')}</p>;
  }

  return (
    <div className="overflow-x-auto" data-testid="programme-slots">
      <Table>
        <THead>
          <TR>
            <TH>{t('studio.programme.slots.when', 'Zaman')}</TH>
            <TH>{t('studio.programme.slots.type', 'Tür')}</TH>
            <TH>{t('studio.programme.slots.status', 'Durum')}</TH>
            <TH numeric>{t('studio.programme.slots.credits', 'Teklif (kredi)')}</TH>
            <TH>{t('studio.programme.slots.reward', 'Ödül')}</TH>
            <TH>{t('studio.programme.slots.actions', 'İşlemler')}</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((s) => {
            const open = openMetrics === s.id;
            const left = hoursLeft(s.editableUntil, now);
            return (
              <Fragment key={s.id}>
                <TR
                  data-testid="programme-slot-row"
                  className={cn('cursor-pointer', open && 'bg-surface-muted/60')}
                  onClick={() => onToggleMetrics(s.id)}
                  aria-expanded={open}
                >
                  <TD className="whitespace-nowrap tabular-nums">
                    {new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(s.scheduledFor))}
                    {s.editable && (
                      <span className="ms-2 text-micro text-muted-foreground">
                        {t('studio.programme.slots.editableFor', '{{hours}} sa düzenlenebilir', { hours: left })}
                      </span>
                    )}
                  </TD>
                  <TD>
                    <span className="flex items-center gap-2">
                      <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full border', typeColour(s.contentTypeKey))} aria-hidden="true" />
                      <span className="flex flex-col">
                        <span className="font-medium">{s.contentTypeName}</span>
                        {s.concept && <span className="max-w-[18rem] truncate text-micro text-muted-foreground">{s.concept.title}</span>}
                      </span>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="text-muted-foreground"
                            aria-label={t('studio.programme.slots.why', 'Neden bu tür?')}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Info className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          {s.selectionReason}
                          {s.trendTitle && ` · ${t('studio.programme.editor.trend', 'Trend kancası')}: ${s.trendTitle}`}
                        </TooltipContent>
                      </Tooltip>
                    </span>
                  </TD>
                  <TD>
                    <Badge tone={SLOT_TONE[s.status] ?? 'neutral'} size="sm" className="gap-1">
                      <span aria-hidden="true">{statusGlyph(s.status)}</span>
                      {t(`studio.programme.slotStatus.${s.status}`, s.status)}
                    </Badge>
                    {s.error && <span className="ms-2 text-micro text-danger">{s.error}</span>}
                  </TD>
                  <TD numeric>{s.quotedCredits ?? '—'}</TD>
                  <TD>
                    <RewardBar value={s.reward} />
                  </TD>
                  <TD>
                    <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="sm" className="h-7 px-2" disabled={!s.editable} onClick={() => onEdit(s.id)} aria-label={t('common.edit', 'Düzenle')}>
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 px-2" disabled={!s.editable || busy} onClick={() => onSkip(s.id)} aria-label={t('studio.programme.editor.skip', 'Atla')}>
                        <SkipForward className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 px-2" disabled={!s.editable || busy} onClick={() => onRegenerate(s.id)} aria-label={t('studio.programme.editor.regenerate', 'Yeniden üret')}>
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onToggleMetrics(s.id)}>
                        {t('studio.programme.editor.metrics', 'Metrikler')}
                      </Button>
                    </span>
                  </TD>
                </TR>
                {open && (
                  <TR className="bg-surface-muted/40 hover:bg-surface-muted/40">
                    <TD colSpan={6}>
                      <SlotMetrics programmeId={programmeId} slotId={s.id} />
                    </TD>
                  </TR>
                )}
              </Fragment>
            );
          })}
        </TBody>
      </Table>
    </div>
  );
}

/** A 0..1 reward as a short bar with the number beside it; "—" when unmeasured. */
function RewardBar({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span className="inline-flex items-center gap-2" data-testid="programme-reward">
      <span className="h-1.5 w-16 rounded-full bg-border" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={value}>
        <span className={cn('block h-full rounded-full', value >= 0.5 ? 'bg-success' : 'bg-warning')} style={{ width: `${pct}%` }} />
      </span>
      <span className="tabular-nums text-xs">{value.toFixed(2)}</span>
    </span>
  );
}

const METRIC_COLUMNS = ['impressions', 'reach', 'engagements', 'likes', 'comments', 'shares', 'saves', 'videoViews', 'leads'] as const;

/**
 * One slot's measured numbers: the targets per network with the latest
 * metric snapshot, the reward breakdown as the engine wrote it, and the
 * concept's title and hook. Read-only by design — the storyboard editor is
 * the content line's, and this is a metrics view, not a second one.
 */
function SlotMetrics({ programmeId, slotId }: { programmeId: string; slotId: string }) {
  const { t, i18n } = useTranslation('marketing');
  const q = useQuery({
    queryKey: programmeKeys.slotMetrics(programmeId, slotId),
    queryFn: () => slotMetrics(programmeId, slotId),
    meta: { silent: true },
  });

  const columnLabel: Record<(typeof METRIC_COLUMNS)[number], string> = {
    impressions: t('studio.programme.metrics.impressions', 'Gösterim'),
    reach: t('studio.programme.metrics.reach', 'Erişim'),
    engagements: t('studio.programme.metrics.engagements', 'Etkileşim'),
    likes: t('studio.programme.metrics.likes', 'Beğeni'),
    comments: t('studio.programme.metrics.comments', 'Yorum'),
    shares: t('studio.programme.metrics.shares', 'Paylaşım'),
    saves: t('studio.programme.metrics.saves', 'Kaydetme'),
    videoViews: t('studio.programme.metrics.videoViews', 'Video izlenme'),
    leads: t('studio.programme.metrics.leads', 'Aday'),
  };

  if (q.isLoading) {
    return (
      <div className="flex gap-2" data-testid="programme-metrics-loading">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-24" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="flex items-center gap-2 text-xs text-danger">
        {t('studio.programme.metrics.error', 'Metrikler okunamadı.')}
        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => q.refetch()}>
          {t('common.retry', 'Yeniden dene')}
        </Button>
      </div>
    );
  }

  const m = q.data;
  const breakdown = m.rewardBreakdown && typeof m.rewardBreakdown === 'object' ? (m.rewardBreakdown as Record<string, unknown>) : null;

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="programme-metrics">
      {m.concept && (
        <p className="text-xs">
          <span className="font-medium">{m.concept.title}</span>
          {' — '}
          <span className="text-muted-foreground">{m.concept.hook}</span>
          <span className="ms-2 text-muted-foreground">
            {t('studio.programme.metrics.beats', '{{beats}} kare · {{seconds}} sn', { beats: m.concept.beats, seconds: m.concept.durationSec })}
          </span>
        </p>
      )}
      {m.item && (
        <p className="text-xs text-muted-foreground">
          {t('studio.programme.metrics.item', 'Kampanya öğesi: {{status}}', { status: m.item.status })}
          {m.item.error && <span className="ms-2 text-danger">{m.item.error}</span>}
        </p>
      )}
      {m.post && (
        <p className="text-xs text-muted-foreground">
          {m.post.publishedAt
            ? t('studio.programme.metrics.publishedAt', 'Yayınlandı: {{when}}', {
                when: new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(m.post.publishedAt)),
              })
            : t('studio.programme.metrics.notPublished', 'Henüz yayınlanmadı.')}
        </p>
      )}

      {m.targets.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('studio.programme.metrics.noTargets', 'Hedef yok — slot henüz yayınlanmadı.')}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>{t('studio.programme.metrics.network', 'Ağ')}</TH>
                <TH>{t('studio.programme.metrics.status', 'Durum')}</TH>
                {METRIC_COLUMNS.map((c) => (
                  <TH key={c} numeric>
                    {columnLabel[c]}
                  </TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {m.targets.map((tg) => (
                <TR key={tg.network} data-testid="programme-metrics-target">
                  <TD>{tg.network}</TD>
                  <TD>{tg.status}</TD>
                  {METRIC_COLUMNS.map((c) => (
                    <TD key={c} numeric>
                      {tg.latest ? tg.latest[c] : '—'}
                    </TD>
                  ))}
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="font-medium">{t('studio.programme.metrics.reward', 'Ödül')}:</span>
        <RewardBar value={m.reward} />
        {breakdown &&
          Object.entries(breakdown).map(([network, parts]) => (
            <span key={network} className="rounded-md border border-border px-2 py-0.5 text-muted-foreground" data-testid="programme-reward-part">
              <span className="font-medium text-foreground">{network}</span>{' '}
              {parts && typeof parts === 'object'
                ? Object.entries(parts as Record<string, unknown>)
                    .filter(([, v]) => typeof v === 'number')
                    .map(([k, v]) => `${k} ${Number(v).toFixed(2)}`)
                    .join(' · ')
                : String(parts)}
            </span>
          ))}
      </div>
    </div>
  );
}

export default ProgrammePanel;
