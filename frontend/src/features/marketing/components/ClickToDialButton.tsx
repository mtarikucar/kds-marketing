import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Phone } from 'lucide-react';
import { toast } from 'sonner';
import marketingApi from '../api/marketingApi';
import { PhoneInput } from '@/components/ui/PhoneInput';
import type { SalesCall, StartCallResult } from '../types';
import { CALL_OUTCOMES } from '../types';
import { expectRingback } from '../webphone/WebphoneHost';

const errMsg = (err: any, fallback: string) => err?.response?.data?.message || fallback;

/**
 * Reusable click-to-dial affordance for the single company line.
 *   1. POST /calls/start → backend reserves the line, returns a `tel:` dialUri
 *   2. window.location → the rep's softphone dials
 *   3. a modal collects the outcome → POST /calls/:id/log frees the line
 * Drop it into the calls page header, or later into the lead detail with a
 * `leadId` + `defaultPhone` so the call mirrors onto that lead's timeline.
 */
export default function ClickToDialButton({
  leadId,
  defaultPhone,
}: {
  leadId?: string;
  defaultPhone?: string;
}) {
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState(defaultPhone || '');
  const [activeCall, setActiveCall] = useState<SalesCall | null>(null);
  const [logForm, setLogForm] = useState({ status: 'CONNECTED', durationSec: '', notes: '' });

  const start = useMutation({
    mutationFn: () =>
      marketingApi
        .post<StartCallResult>('/calls/start', { toPhone: phone.trim(), leadId: leadId || undefined })
        .then((r) => r.data),
    onSuccess: (data) => {
      setActiveCall(data.call);
      setLogForm({ status: 'CONNECTED', durationSec: '', notes: '' });
      if (data.mode === 'api') {
        // api-dial: NetGSM rings the rep's extension first, then the customer. The
        // request was accepted — the extension only actually rings if a device
        // (the webphone) is registered on it. Keep the copy honest (not "ringing").
        toast.success('Call request sent — your extension will ring (keep the webphone open).');
        // Finding H1: this REST dial never touches webphone.store.ts's own
        // `call()`, so nothing else arms the ring-back-expectation window —
        // without this, the extension ring-back INVITE would surface the
        // accept/reject dialog instead of auto-answering silently. Reach the
        // app-wide webphone instance via WebphoneHost's module singleton.
        expectRingback(phone.trim());
      } else if (data.dialUri) {
        window.location.href = data.dialUri; // click-to-dial hands off to the device
      }
      queryClient.invalidateQueries({ queryKey: ['marketing', 'calls'] });
    },
    onError: (e: any) => toast.error(errMsg(e, 'Failed to start call')),
  });

  const log = useMutation({
    mutationFn: () =>
      marketingApi.post(`/calls/${activeCall!.id}/log`, {
        status: logForm.status,
        durationSec: logForm.durationSec ? Number(logForm.durationSec) : undefined,
        notes: logForm.notes || undefined,
      }),
    onSuccess: () => {
      toast.success('Call logged');
      setActiveCall(null);
      queryClient.invalidateQueries({ queryKey: ['marketing', 'calls'] });
    },
    onError: (e: any) => toast.error(errMsg(e, 'Failed to log call')),
  });

  return (
    <>
      <div className="flex items-center gap-2">
        <PhoneInput
          value={phone}
          onChange={setPhone}
          className="flex-1 min-w-0 sm:flex-none sm:w-44"
        />
        <button
          onClick={() => {
            if (!phone.trim()) { toast.error('Enter a phone number'); return; }
            start.mutate();
          }}
          disabled={start.isPending}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          <Phone className="w-4 h-4" />
          {start.isPending ? 'Starting…' : 'Call'}
        </button>
      </div>

      {activeCall && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setActiveCall(null)}>
          <div className="bg-background rounded-xl shadow-xl w-full max-w-sm p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-foreground">Log call outcome</h2>
            <p className="text-sm text-muted-foreground">Dialing {activeCall.toPhone}</p>
            <select
              value={logForm.status}
              onChange={(e) => setLogForm({ ...logForm, status: e.target.value })}
              className="w-full px-3 py-2 border border-input rounded-lg text-sm bg-background text-foreground"
            >
              {CALL_OUTCOMES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            {logForm.status === 'CONNECTED' && (
              <input
                type="number"
                min={0}
                placeholder="Duration (seconds)"
                value={logForm.durationSec}
                onChange={(e) => setLogForm({ ...logForm, durationSec: e.target.value })}
                className="w-full px-3 py-2 border border-input rounded-lg text-sm bg-background text-foreground"
              />
            )}
            <textarea
              placeholder="Notes"
              value={logForm.notes}
              onChange={(e) => setLogForm({ ...logForm, notes: e.target.value })}
              className="w-full px-3 py-2 border border-input rounded-lg text-sm resize-none bg-background text-foreground"
              rows={3}
            />
            <div className="flex gap-2">
              <button onClick={() => log.mutate()} disabled={log.isPending} className="flex-1 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium disabled:opacity-50">
                {log.isPending ? 'Saving…' : 'Save outcome'}
              </button>
              <button onClick={() => setActiveCall(null)} className="px-4 py-2 border border-input rounded-lg text-sm text-muted-foreground hover:text-foreground">Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
