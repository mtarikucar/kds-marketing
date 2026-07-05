import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PhoneCall, SkipForward, Play, X, CheckCircle2 } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import {
  PageHeader, Card, CardContent, Button, Input, Field, Badge, Progress, EmptyState,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui';

interface CurrentLead { itemId: string; callId: string | null; lead: { id: string; businessName: string | null; contactPerson: string | null; phone: string | null; status: string; city: string | null } }
interface DialSession { id: string; status: string; currentIndex: number; total: number; done: number; current: CurrentLead | null }

const OUTCOMES = ['CONNECTED', 'NO_ANSWER', 'BUSY', 'FAILED', 'CANCELLED'] as const;

function apiErr(e: any, fallback: string): string {
  return e?.response?.data?.message ?? fallback;
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

  const refresh = (s: DialSession) => { setSession(s); setNotes(''); setDuration(''); };

  const dial = useMutation({
    mutationFn: () => marketingApi.post(`/dialer/sessions/${session!.id}/dial`).then((r) => r.data as { dialUri: string; mode: string }),
    onSuccess: (res) => {
      // Click-to-dial (netgsm-lite) hands back a tel: URI for the softphone;
      // api-dial (Netsantral) originates server-side with an empty dialUri — give
      // the rep explicit feedback in that mode so the button isn't a silent no-op.
      if (res.dialUri) window.location.href = res.dialUri;
      else toast.success(t('dialer.calling', { defaultValue: 'Calling… answer your handset.' }));
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
    onSuccess: () => setSession(null),
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
