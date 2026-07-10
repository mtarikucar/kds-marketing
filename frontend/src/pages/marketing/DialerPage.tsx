import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PhoneCall, SkipForward, Play, X, CheckCircle2, Users } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { useEntitlements } from '../../features/marketing/hooks/useEntitlements';
import { expectRingback, setActiveCallId } from '../../features/marketing/webphone/WebphoneHost';
import {
  PageHeader, Card, CardContent, Button, Input, Field, Badge, Progress, EmptyState, Callout, Switch,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui';

interface CurrentLead { itemId: string; callId: string | null; lead: { id: string; businessName: string | null; contactPerson: string | null; phone: string | null; status: string; city: string | null } }
interface DialSession { id: string; status: string; currentIndex: number; total: number; done: number; current: CurrentLead | null }

/** Auto-dialer ("parallel mode") session summary — NetGSM Phase 5 Task 5. */
interface AutocallSession {
  id: string;
  status: string;
  queueName: string;
  netgsmListId: string;
  total: number;
  pending: number;
  added: number;
  skipped: number;
  failed: number;
}

const OUTCOMES = ['CONNECTED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED'] as const;

function apiErr(e: any, fallback: string): string {
  return e?.response?.data?.message ?? fallback;
}

/**
 * Parallel power-dialer toggle (NetGSM Phase 5 Task 5) — dials many leads at
 * once into a live NetGSM autocall list routed at a staffed Netsantral queue,
 * unlike the preview queue above (one lead at a time, single line). Requires
 * the paid "Otomatik Arama" add-on + a pre-staffed queue in the NetGSM panel;
 * this app cannot verify either, so the prerequisite is surfaced as a note
 * rather than a blocking check.
 */
function ParallelModeSection({ status, search }: { status: string; search: string }) {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const { has } = useEntitlements();
  const entitled = has('voiceCampaigns'); // paid add-on / SCALE+ — the backend route is @RequiresFeature('voiceCampaigns')
  const [queueName, setQueueName] = useState('');
  const [iysType, setIysType] = useState<'TICARI' | 'BILGILENDIRME'>('TICARI');

  const active = useQuery({
    queryKey: ['dialer-parallel-active'],
    // Don't fire the request for an unentitled workspace — it would 403 silently.
    enabled: entitled,
    queryFn: () => marketingApi.get('/dialer/parallel/active').then((r) => r.data as AutocallSession | null),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['dialer-parallel-active'] });

  const start = useMutation({
    mutationFn: () =>
      marketingApi
        .post('/dialer/parallel/start', {
          status: status || undefined,
          search: search || undefined,
          queueName,
          iysMessageType: iysType,
        })
        .then((r) => r.data as AutocallSession),
    onSuccess: refresh,
    onError: (e) => toast.error(apiErr(e, 'Could not start the parallel session')),
  });

  const stop = useMutation({
    mutationFn: () => marketingApi.post('/dialer/parallel/stop', { sessionId: active.data!.id }).then((r) => r.data),
    onSuccess: refresh,
    onError: (e) => toast.error(apiErr(e, 'Could not stop the parallel session')),
  });

  const session = active.data ?? null;
  const busy = start.isPending || stop.isPending;

  // Hide the whole parallel-mode card unless the feature is granted (the backend
  // route is @RequiresFeature('voiceCampaigns')). Placed after all hooks so the
  // hook order stays stable across renders.
  if (!entitled) return null;

  return (
    <Card className="max-w-lg">
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium text-foreground">{t('dialer.parallel.title', { defaultValue: 'Parallel mode' })}</p>
              <p className="text-xs text-muted-foreground">
                {t('dialer.parallel.subtitle', { defaultValue: 'Dial many leads at once into a live agent queue.' })}
              </p>
            </div>
          </div>
          <Switch
            aria-label={t('dialer.parallel.toggleLabel', { defaultValue: 'Parallel mode' })}
            checked={!!session}
            disabled={busy || (!session && !queueName.trim())}
            onCheckedChange={(checked) => {
              if (checked) start.mutate();
              else stop.mutate();
            }}
          />
        </div>

        <Callout tone="info">
          {t('dialer.parallel.prereqNote', {
            defaultValue:
              'Requires the paid NetGSM "Otomatik Arama" add-on and a Netsantral queue with logged-in agents — set both up in the NetGSM panel first.',
          })}
        </Callout>

        {session ? (
          <div className="space-y-2 text-sm">
            <p className="text-foreground">
              {t('dialer.parallel.queueLabel', { defaultValue: 'Queue' })}: <span className="font-medium">{session.queueName}</span>
            </p>
            <div className="flex items-center gap-2">
              <Progress value={session.total ? ((session.added + session.skipped + session.failed) / session.total) * 100 : 0} className="flex-1" />
              <span className="text-xs font-medium text-muted-foreground">
                {t('dialer.parallel.progress', {
                  defaultValue: '{{added}} added / {{pending}} pending',
                  added: session.added,
                  pending: session.pending,
                })}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge tone="success" size="sm">{t('dialer.parallel.added', { defaultValue: '{{n}} added', n: session.added })}</Badge>
              <Badge tone="neutral" size="sm">{t('dialer.parallel.pending', { defaultValue: '{{n}} pending', n: session.pending })}</Badge>
              <Badge tone="warning" size="sm">{t('dialer.parallel.skipped', { defaultValue: '{{n}} skipped', n: session.skipped })}</Badge>
              {session.failed > 0 && <Badge tone="danger" size="sm">{t('dialer.parallel.failed', { defaultValue: '{{n}} failed', n: session.failed })}</Badge>}
            </div>
          </div>
        ) : (
          <>
            <Field label={t('dialer.parallel.queueName', { defaultValue: 'Netsantral queue name' })}>
              {({ id }) => (
                <Input
                  id={id}
                  value={queueName}
                  onChange={(e) => setQueueName(e.target.value)}
                  placeholder={t('dialer.parallel.queueNamePlaceholder', { defaultValue: 'e.g. sales-queue' })}
                />
              )}
            </Field>
            <Field label={t('dialer.parallel.iysType', { defaultValue: 'Message type' })}>
              {({ id }) => (
                <Select value={iysType} onValueChange={(v) => setIysType(v as 'TICARI' | 'BILGILENDIRME')}>
                  <SelectTrigger id={id}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TICARI">{t('dialer.parallel.ticari', { defaultValue: 'Commercial (TİCARİ)' })}</SelectItem>
                    <SelectItem value="BILGILENDIRME">{t('dialer.parallel.bilgilendirme', { defaultValue: 'Informational (BİLGİLENDİRME)' })}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Preview dialer (Epic 11b) — build a queue from a lead filter, then dial leads
 * one at a time (single-line click-to-dial), logging each outcome to auto-advance.
 *
 * `embedded` — rendered inside another page's tab (Calls); skips the own
 * PageHeader but keeps the End-session action in a toolbar row.
 */
export default function DialerPage({ embedded }: { embedded?: boolean } = {}) {
  const { t } = useTranslation('marketing');
  const [session, setSession] = useState<DialSession | null>(null);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [notes, setNotes] = useState('');
  const [duration, setDuration] = useState('');

  const start = useMutation({
    mutationFn: () => marketingApi.post('/dialer/sessions', { status: status || undefined, search: search || undefined }).then((r) => r.data as DialSession),
    onSuccess: (s) => setSession(s),
    onError: (e) => toast.error(apiErr(e, 'No callable leads match')),
  });

  // The in-call controls panel has nothing left to control once the session
  // moves off this lead (logged/skipped) — the id it tracks belonged to the
  // call that just ended.
  const refresh = (s: DialSession) => { setSession(s); setNotes(''); setDuration(''); setActiveCallId(null); };

  const dial = useMutation({
    mutationFn: () =>
      marketingApi
        .post(`/dialer/sessions/${session!.id}/dial`)
        .then((r) => r.data as { dialUri: string; mode: string; call: { id: string } }),
    onSuccess: (res) => {
      // Click-to-dial (netgsm-lite) hands back a tel: URI for the softphone;
      // api-dial (Netsantral) originates server-side with an empty dialUri — give
      // the rep explicit feedback in that mode so the button isn't a silent no-op.
      if (res.mode === 'api') {
        toast.success(t('dialer.calling', { defaultValue: 'Calling… answer your handset.' }));
        // Finding H1: this REST dial never touches webphone.store.ts's own
        // `call()`, so nothing else arms the ring-back-expectation window —
        // without this, the extension ring-back INVITE would surface the
        // accept/reject dialog instead of auto-answering silently. Reach the
        // app-wide webphone instance via WebphoneHost's module singleton.
        // Also hand it the SalesCall id (Phase 3 Task 5) so its in-call
        // controls panel can show hangup/transfer immediately — including
        // for bridge-mode calls, which never touch this tab's SIP session.
        // Must come from THIS dial's response (`res.call.id`), not
        // `session.current.callId` — the session snapshot's callId is only
        // populated by the backend AFTER dial() completes, so it's still
        // null/stale for a fresh queue item at the moment this fires.
        expectRingback(session?.current?.lead.phone ?? undefined, res.call?.id ?? undefined);
      } else if (res.dialUri) {
        window.location.href = res.dialUri;
      }
    },
    onError: (e) => toast.error(apiErr(e, 'Could not start the call — log or cancel the active one first')),
  });

  const log = useMutation({
    mutationFn: (outcome: string) =>
      marketingApi.post(`/dialer/sessions/${session!.id}/log`, {
        status: outcome,
        durationSec: duration ? Number(duration) : undefined,
        notes: notes || undefined,
      }).then((r) => r.data as DialSession),
    onSuccess: refresh,
    onError: (e) => toast.error(apiErr(e, 'Could not log the outcome')),
  });

  const skip = useMutation({
    mutationFn: () => marketingApi.post(`/dialer/sessions/${session!.id}/skip`).then((r) => r.data as DialSession),
    onSuccess: refresh,
    onError: (e) => toast.error(apiErr(e, 'Could not skip to the next lead')),
  });

  const cancel = useMutation({
    mutationFn: () => marketingApi.post(`/dialer/sessions/${session!.id}/cancel`).then((r) => r.data),
    onSuccess: () => { setSession(null); setActiveCallId(null); },
    onError: (e) => toast.error(apiErr(e, 'Could not end the session')),
  });

  // ── Queue setup screen ──────────────────────────────────────────────────────
  if (!session) {
    return (
      <div className="space-y-6">
        {!embedded && (
          <PageHeader title={t('dialer.title', { defaultValue: 'Power Dialer' })} description={t('dialer.subtitle', { defaultValue: 'Queue up leads and dial them one after another.' })} />
        )}
        <Card className="max-w-lg">
          <CardContent className="space-y-4 p-5">
            <Field label={t('dialer.filterStatus', { defaultValue: 'Status (optional)' })}>
              {({ id }) => (
                <Select value={status || 'ALL'} onValueChange={(v) => setStatus(v === 'ALL' ? '' : v)}>
                  <SelectTrigger id={id}><SelectValue placeholder={t('dialer.anyStatus', { defaultValue: 'Any status' })} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL">{t('dialer.anyStatus', { defaultValue: 'Any status' })}</SelectItem>
                    {['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL', 'WON', 'LOST'].map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field label={t('dialer.search', { defaultValue: 'Search name/phone (optional)' })}>
              {({ id }) => <Input id={id} value={search} onChange={(e) => setSearch(e.target.value)} />}
            </Field>
            <p className="text-xs text-muted-foreground">{t('dialer.callableHint', { defaultValue: 'Only leads with a phone number are queued (up to 100).' })}</p>
            <Button onClick={() => start.mutate()} loading={start.isPending}>
              <Play className="h-4 w-4" />{t('dialer.startQueue', { defaultValue: 'Start dialing' })}
            </Button>
          </CardContent>
        </Card>

        <ParallelModeSection status={status} search={search} />
      </div>
    );
  }

  const c = session.current;
  const finished = session.status !== 'ACTIVE' || !c;
  // Disable EVERY queue action while any one is in flight — otherwise a rep can
  // e.g. click Skip while Dial is pending, orphaning the live call on the line.
  const busy = dial.isPending || log.isPending || skip.isPending || cancel.isPending;

  // The End-session action must stay reachable even without the PageHeader.
  const endSessionBtn = (
    <Button variant="outline" size="sm" onClick={() => cancel.mutate()}>
      <X className="h-4 w-4" />{t('dialer.end', { defaultValue: 'End session' })}
    </Button>
  );

  return (
    <div className="space-y-6">
      {embedded ? (
        <div className="flex max-w-xl justify-end">{endSessionBtn}</div>
      ) : (
        <PageHeader title={t('dialer.title', { defaultValue: 'Power Dialer' })} actions={endSessionBtn} />
      )}

      <Card className="max-w-xl">
        <CardContent className="p-5">
          <div className="mb-4 flex items-center gap-2">
            <Progress value={session.total ? (session.done / session.total) * 100 : 0} className="flex-1" />
            <span className="text-xs font-medium text-muted-foreground">
              {t('dialer.progress', { defaultValue: '{{done}} / {{total}}', done: session.done, total: session.total })}
            </span>
          </div>

          {finished ? (
            <EmptyState
              icon={<CheckCircle2 className="h-10 w-10 text-success" />}
              title={t('dialer.finished', { defaultValue: 'Queue complete' })}
              description={t('dialer.finishedHint', { defaultValue: 'You worked through every lead in this queue.' })}
              action={<Button onClick={() => setSession(null)}>{t('dialer.newQueue', { defaultValue: 'New queue' })}</Button>}
            />
          ) : (
            <>
              <div className="rounded-lg border border-border p-4">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-lg font-semibold text-foreground">{c!.lead.businessName || c!.lead.contactPerson || c!.lead.phone}</p>
                    <p className="text-sm text-muted-foreground">{c!.lead.contactPerson}{c!.lead.city ? ` · ${c!.lead.city}` : ''}</p>
                  </div>
                  <Badge tone="neutral" size="sm">{c!.lead.status}</Badge>
                </div>
                <p className="mt-2 font-mono text-xl tabular-nums text-foreground">{c!.lead.phone}</p>
                <div className="mt-3 flex gap-2">
                  <Button onClick={() => dial.mutate()} loading={dial.isPending} disabled={busy}><PhoneCall className="h-4 w-4" />{t('dialer.dial', { defaultValue: 'Dial' })}</Button>
                  <Button variant="outline" onClick={() => skip.mutate()} loading={skip.isPending} disabled={busy}><SkipForward className="h-4 w-4" />{t('dialer.skip', { defaultValue: 'Skip' })}</Button>
                </div>
              </div>

              <div className="mt-4 space-y-3">
                <p className="text-sm font-medium text-foreground">{t('dialer.logOutcome', { defaultValue: 'Log the outcome' })}</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t('dialer.duration', { defaultValue: 'Talk time (sec)' })}>
                    {({ id }) => <Input id={id} type="number" min="0" value={duration} onChange={(e) => setDuration(e.target.value)} />}
                  </Field>
                  <Field label={t('dialer.notes', { defaultValue: 'Notes' })}>
                    {({ id }) => <Input id={id} value={notes} onChange={(e) => setNotes(e.target.value)} />}
                  </Field>
                </div>
                <div className="flex flex-wrap gap-2">
                  {OUTCOMES.map((o) => (
                    <Button key={o} size="sm" variant={o === 'CONNECTED' ? 'primary' : 'outline'} loading={log.isPending} disabled={busy} onClick={() => log.mutate(o)}>
                      {t(`dialer.outcomes.${o}`, { defaultValue: o })}
                    </Button>
                  ))}
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
