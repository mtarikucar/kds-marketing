import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, Phone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { isApiError } from '@/api/client';
import {
  CALL_PURPOSES,
  REFUSAL_REASONS,
  listCalls,
  placeCall,
  type CallPurpose,
  type CallView,
  type RefusalReason,
} from '@/api/calls';
import { useSession } from '@/auth/useSession';
import { QueryState } from '@/components/QueryState';
import {
  Badge,
  Button,
  Callout,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  PageHeader,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { can } from '@/lib/roles';
import { CallsPolicy } from './CallsPolicy';

export const CALLS_KEY = ['calls'] as const;
type CallQueue = 'all' | 'open' | 'unrecorded';
const CALLS_PER_PAGE = 10;

/** A missing outcome is work only after the line has ended, never during a live call. */
function inQueue(call: CallView, queue: CallQueue): boolean {
  if (queue === 'open') return call.state !== 'ended';
  if (queue === 'unrecorded') return call.state === 'ended' && call.outcome === null;
  return true;
}

/** `m:ss` of a duration in seconds, or a dash. */
export function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** The refusal a placed call met, when the server refused it with a known reason. */
function refusalOf(err: unknown): RefusalReason | null {
  if (!isApiError(err) || err.code !== 'CONFLICT') return null;
  const reason = err.details.reason;
  return typeof reason === 'string' && (REFUSAL_REASONS as readonly string[]).includes(reason)
    ? (reason as RefusalReason)
    : null;
}

/** "Place a call": a rep's call through the PBX (the rep's extension rings first). */
function PlaceCallDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState('');
  const [extension, setExtension] = useState('');
  const [purpose, setPurpose] = useState<CallPurpose>('service');
  const place = useMutation({
    mutationFn: () => {
      const value = target.trim();
      const byId = /^[0-9a-f-]{36}$/i.test(value);
      return placeCall({
        ...(byId ? { person_id: value } : { phone: value }),
        purpose,
        mode: 'human',
        rep_extension: extension.trim(),
      });
    },
    onSuccess: async () => {
      toast.success(t('calls.place.placed'));
      onOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: CALLS_KEY });
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: CALLS_KEY });
    },
  });
  const refusal = refusalOf(place.error);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!place.isPending) place.mutate();
  };
  return (
    <Dialog open={open} onOpenChange={(value) => { if (!place.isPending) onOpenChange(value); }}>
      <DialogContent dismissible={!place.isPending}>
        <DialogHeader>
          <DialogTitle>{t('calls.place.title')}</DialogTitle>
          <DialogDescription>{t('calls.place.description')}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit} noValidate>
          <Field label={t('calls.place.target')} hint={t('calls.place.targetHint')}>
            {(ids) => (
              <Input
                id={ids.id}
                aria-describedby={ids.describedBy}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                required
              />
            )}
          </Field>
          <Field label={t('calls.place.extension')} hint={t('calls.place.extensionHint')}>
            {(ids) => (
              <Input
                id={ids.id}
                aria-describedby={ids.describedBy}
                inputMode="numeric"
                value={extension}
                onChange={(e) => setExtension(e.target.value)}
                required
              />
            )}
          </Field>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{t('calls.place.purpose')}</legend>
            {CALL_PURPOSES.map((p) => (
              <label key={p} className={`flex cursor-pointer items-start gap-3 border-l-2 px-3 py-3 text-sm ${purpose === p ? 'border-brand-accent bg-surface-muted' : 'border-transparent'}`}>
                <input
                  type="radio"
                  className="mt-1 accent-primary"
                  name="purpose"
                  value={p}
                  checked={purpose === p}
                  onChange={() => setPurpose(p)}
                />
                <span>
                  <span className="font-medium">{t(`calls.purposes.${p}`)}</span>
                  <span className="block text-caption text-muted-foreground">{t(`calls.purposeHints.${p}`)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {place.error && (
            <Callout tone="warning">
              {refusal
                ? t('calls.place.refused', { reason: t(`calls.refusals.${refusal}`) })
                : errorMessage(t, place.error)}
            </Callout>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={place.isPending} onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={place.isPending} disabled={!target.trim() || !extension.trim()}>
              {t('calls.place.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CallRow({ call, canManage }: { call: CallView; canManage: boolean }) {
  const { t, i18n } = useTranslation();
  const unrecorded = inQueue(call, 'unrecorded');
  return (
    <TR className="hover:bg-surface-muted">
      <TD className="whitespace-nowrap">
        <Link to={`/calls/${encodeURIComponent(call.id)}`} className="rounded-sm font-medium text-foreground underline-offset-4 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {formatDateTime(call.started_at, i18n.language)}
        </Link>
        <div className="mt-2">
          <Button asChild size="sm" variant={unrecorded && canManage ? 'outline' : 'ghost'} className="h-7 px-2">
            <Link to={`/calls/${encodeURIComponent(call.id)}`}>
              {unrecorded && canManage
                ? t('calls.workbench.recordOutcome', { defaultValue: 'Sonuç kaydet' })
                : t('calls.workbench.openCall', { defaultValue: 'Aramayı incele' })}
            </Link>
          </Button>
        </div>
      </TD>
      <TD><span className="inline-flex items-center gap-2 text-muted-foreground">{call.direction === 'inbound' ? <ArrowDownLeft className="h-4 w-4" aria-hidden="true" /> : <ArrowUpRight className="h-4 w-4" aria-hidden="true" />}{t(`calls.directions.${call.direction}`)}</span></TD>
      <TD className="min-w-[12rem] max-w-xs" data-masked-number="">
        <span className="whitespace-nowrap font-medium tabular-nums">{call.counterpart}</span>
        {call.summary && <p className="mt-1 line-clamp-2 text-caption leading-5 text-muted-foreground" title={call.summary}>{call.summary}</p>}
      </TD>
      <TD>{t(`calls.purposes.${call.purpose}`)}</TD>
      <TD>
        <Badge size="sm" tone={call.state === 'ended' ? 'neutral' : 'primary'}>
          {t(`calls.states.${call.state}`)}
        </Badge>
      </TD>
      <TD className="whitespace-nowrap tabular-nums">{duration(call.duration_s)}</TD>
      <TD>{call.outcome ? t(`calls.outcomes.${call.outcome}`) : unrecorded ? <span className="text-warning">{t('calls.workbench.outcomeMissing', { defaultValue: 'Sonuç kaydedilmemiş' })}</span> : '—'}</TD>
      <TD>{call.mode.kind === 'human' ? t('calls.modes.human', { ext: call.mode.rep_extension }) : t('calls.modes.agent')}</TD>
    </TR>
  );
}

/** `/calls`: the call log, "Place a call" for whoever may call, and the call policy. */
export function CallsPage() {
  const { t, i18n } = useTranslation();
  const session = useSession();
  const canCall = can(session.data, 'calls.work');
  const canManage = can(session.data, 'calls.manage');
  const [placing, setPlacing] = useState(false);
  const [direction, setDirection] = useState<'all' | 'inbound' | 'outbound'>('all');
  const [queue, setQueue] = useState<CallQueue>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [view, setView] = useState('calls');
  const [settingsOpened, setSettingsOpened] = useState(false);
  const selectedView = canManage ? view : 'calls';
  const calls = useQuery({ queryKey: CALLS_KEY, queryFn: () => listCalls(), enabled: canCall });
  const query = search.trim().toLocaleLowerCase(i18n.language);
  const matchingCalls = (calls.data ?? []).filter((call) => {
    if (direction !== 'all' && call.direction !== direction) return false;
    const searchable = [call.counterpart, call.mode.kind === 'human' ? call.mode.rep_extension : '', call.summary ?? ''];
    return !query || searchable.some((value) => value.toLocaleLowerCase(i18n.language).includes(query));
  });
  const filteredCalls = matchingCalls.filter((call) => inQueue(call, queue));
  const lastPage = Math.max(0, Math.ceil(filteredCalls.length / CALLS_PER_PAGE) - 1);
  const currentPage = Math.min(page, lastPage);
  const first = currentPage * CALLS_PER_PAGE;
  const visibleCalls = filteredCalls.slice(first, first + CALLS_PER_PAGE);
  useEffect(() => {
    // A refresh may remove the rows on the last page. Never leave the reader on a blank page.
    if (page > lastPage) setPage(lastPage);
  }, [page, lastPage]);
  const queueLabels = {
    all: t('calls.workbench.allCalls', { defaultValue: 'Tüm aramalar' }),
    open: t('calls.workbench.openCalls', { defaultValue: 'Açık aramalar' }),
    unrecorded: t('calls.workbench.unrecordedCalls', { defaultValue: 'Sonuç bekleyenler' }),
  };
  const clearFilters = () => {
    setDirection('all');
    setQueue('all');
    setSearch('');
    setPage(0);
  };
  const directionOnly = direction !== 'all' && queue === 'all' && !query;
  if (session.isPending) return <QueryState query={session} />;
  return (
    <>
      <PageHeader
        title={t('calls.title')}
        description={t('calls.description')}
        actions={
          canCall && selectedView === 'calls' ? (
            <Button onClick={() => setPlacing(true)}>
              <Phone className="h-4 w-4" aria-hidden="true" />
              {t('calls.place.open')}
            </Button>
          ) : null
        }
      />
      <Tabs value={selectedView} onValueChange={(value) => { setView(value); if (value === 'settings') setSettingsOpened(true); }}>
        <TabsList aria-label={t('calls.workbench.views', { defaultValue: 'Arama görünümleri' })}>
          <TabsTrigger value="calls">{t('calls.workbench.conversationsTab', { defaultValue: 'Görüşmeler' })}</TabsTrigger>
          {canManage && <TabsTrigger value="settings">{t('calls.workbench.settingsTab', { defaultValue: 'Arama ayarları' })}</TabsTrigger>}
        </TabsList>
        <TabsContent value="calls" className="mt-0">
      {!canCall ? (
        <Callout tone="info">{t('calls.noPermission')}</Callout>
      ) : (
        <QueryState query={calls}>
          {(calls.data ?? []).length === 0 ? (
            <EmptyState className="rounded-none border-x-0" title={t('calls.empty')} description={t('calls.emptyBody')} />
          ) : (
            <section className="min-w-0 border-b border-border bg-surface">
              <div className="flex flex-wrap gap-x-5 gap-y-1 border-b border-border px-5 py-2" role="group" aria-label={t('calls.workbench.queues', { defaultValue: 'Arama iş kuyruğu' })}>
                {(['all', 'open', 'unrecorded'] as const).map((value) => (
                  <Button key={value} size="sm" variant="ghost" aria-pressed={queue === value} className={`h-10 rounded-none border-b-2 px-0 ${queue === value ? 'border-brand-accent text-foreground' : 'border-transparent'}`} onClick={() => { setQueue(value); setPage(0); }}>
                    {queueLabels[value]}
                    <span aria-hidden="true" className="text-caption font-normal tabular-nums text-muted-foreground">{matchingCalls.filter((call) => inQueue(call, value)).length}</span>
                  </Button>
                ))}
              </div>
              <div className="flex flex-wrap items-end gap-x-8 gap-y-4 border-b border-border px-5 py-4">
                <div className="min-w-0 flex-1 basis-64">
                  <Field label={t('calls.workbench.search', { defaultValue: 'Numara, dahili veya özet ara' })}>
                    {(ids) => <Input id={ids.id} type="search" autoComplete="off" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} />}
                  </Field>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-caption text-muted-foreground">{t('calls.columns.direction')}</span>
                  <div className="flex flex-wrap gap-1" role="group" aria-label={t('calls.columns.direction')}>
                  {(['all', 'inbound', 'outbound'] as const).map((value) => (
                    <Button key={value} size="sm" variant="ghost" className={`rounded-none border-b-2 ${direction === value ? 'border-brand-accent text-foreground' : 'border-transparent'}`} aria-pressed={direction === value} onClick={() => { setDirection(value); setPage(0); }}>
                      {value === 'all' ? t('inbox.queue.all') : t(`calls.directions.${value}`)}
                    </Button>
                  ))}
                </div>
                </div>
              </div>
              <div className="flex flex-col gap-1 px-5 py-3 text-caption text-muted-foreground">
                <p role="status" aria-live="polite">{t('calls.workbench.resultCount', { defaultValue: 'Yüklenen {{total}} aramadan {{count}} kayıt eşleşiyor', total: calls.data?.length ?? 0, count: filteredCalls.length })}</p>
                {queue === 'unrecorded' && <p>{t('calls.workbench.unrecordedHint', { defaultValue: 'Biten ama sonucu kaydedilmemiş aramalar. Görüşmeyi açıp sonucu kontrol edin.' })}</p>}
              </div>
            {visibleCalls.length === 0 ? (
              <EmptyState className="rounded-none border-0"
                title={directionOnly ? t('calls.filterEmpty') : t('calls.workbench.filteredEmpty', { defaultValue: 'Bu filtrelerle eşleşen arama yok' })}
                description={directionOnly ? t('calls.filterEmptyBody') : t('calls.workbench.filteredEmptyBody', { defaultValue: 'Aramayı veya seçili kuyruğu değiştirin; tüm kayıtları görmek için filtreleri temizleyin.' })}
                action={<Button variant="outline" onClick={clearFilters}>{t('calls.showAll')}</Button>} />
            ) : (
            <>
            <div className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" tabIndex={0} role="region" aria-label={t('calls.title')}>
            <Table aria-label={t('calls.title')}>
              <THead>
                <TR>
                  <TH>{t('calls.columns.started')}</TH>
                  <TH>{t('calls.columns.direction')}</TH>
                  <TH>{t('calls.columns.number')}</TH>
                  <TH>{t('calls.columns.purpose')}</TH>
                  <TH>{t('calls.columns.state')}</TH>
                  <TH>{t('calls.columns.duration')}</TH>
                  <TH>{t('calls.columns.outcome')}</TH>
                  <TH>{t('calls.columns.who')}</TH>
                </TR>
              </THead>
              <TBody>
                {visibleCalls.map((c) => (
                  <CallRow key={c.id} call={c} canManage={canManage} />
                ))}
              </TBody>
            </Table>
            </div>
            <nav className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3" aria-label={t('calls.workbench.pagination', { defaultValue: 'Arama sayfaları' })}>
              <span className="text-caption tabular-nums text-muted-foreground" aria-live="polite">{t('calls.workbench.pageRange', { defaultValue: '{{first}}–{{last}} / {{total}} kayıt', first: first + 1, last: first + visibleCalls.length, total: filteredCalls.length })}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t('calls.workbench.previousPage', { defaultValue: 'Önceki' })}</Button>
                <Button size="sm" variant="outline" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>{t('calls.workbench.nextPage', { defaultValue: 'Sonraki' })}</Button>
              </div>
            </nav>
            </>
            )}
            </section>
          )}
        </QueryState>
      )}
        </TabsContent>
        {canManage && <TabsContent value="settings" forceMount hidden={selectedView !== 'settings'} className="mt-0 [&>div]:mt-0 [&>div]:border-t-0">{settingsOpened && <CallsPolicy />}</TabsContent>}
      </Tabs>
      {canCall && <PlaceCallDialog open={placing} onOpenChange={setPlacing} />}
    </>
  );
}
