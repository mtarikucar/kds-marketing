import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Pause, Play, Mic, MicOff, Grid3x3, PhoneForwarded, PhoneOff } from 'lucide-react';
import marketingApi from '../api/marketingApi';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';

interface Teammate { id: string; firstName: string; lastName: string; dahili: string }

export interface CallControlsPanelProps {
  /** The active SalesCall id — known as soon as the call is placed/accepted
   *  (see WebphoneHost's `activeCallId`), independent of whether THIS
   *  browser tab holds a SIP leg for it (a bridge-mode call never does). */
  callId: string | null;
  /** True while this tab's own SIP session is `incall` — hold/mute/DTMF only
   *  make sense when there is a local SIP leg to act on. */
  sipActive: boolean;
  held: boolean;
  muted: boolean;
  onHold: () => void;
  onUnhold: () => void;
  onMute: () => void;
  onUnmute: () => void;
  onDtmf: (digit: string) => void;
  /** The call left this rep (hung up server-side, or handed off by
   *  transfer) — lets WebphoneHost clear its `activeCallId`. */
  onCallEnded?: () => void;
}

const DTMF_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

function errMsg(e: any, fallback: string): string {
  return e?.response?.data?.message ?? fallback;
}

/**
 * Floating in-call control panel (NetGSM Phase 3 Task 5). Hold/mute/DTMF act
 * directly on this tab's own SIP.js session (via the webphone store's
 * hold()/unhold()/mute()/unmute()/sendDtmf() — see webphone.store.ts) and are
 * only shown while `sipActive`. Hangup (bridge-mode only — a SIP-active call
 * already has the status-pill's "Kapat" button) and transfer (always) go
 * through the server-side `/marketing/telephony/calls/:id/*` endpoints, which
 * act on the LIVE netsantral call by its `unique_id` regardless of whether
 * this browser holds a SIP leg for it — that's what makes transfer/hangup
 * work for a bridge call too (NetgsmApiAdapter's 'bridge' callMode never
 * opens a SIP session in this tab at all).
 */
export default function CallControlsPanel({
  callId,
  sipActive,
  held,
  muted,
  onHold,
  onUnhold,
  onMute,
  onUnmute,
  onDtmf,
  onCallEnded,
}: CallControlsPanelProps) {
  const { t } = useTranslation('marketing');
  const [showKeypad, setShowKeypad] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [attended, setAttended] = useState(false);

  const { data: teammates } = useQuery<Teammate[]>({
    queryKey: ['marketing', 'telephony', 'teammates'],
    queryFn: () => marketingApi.get('/telephony/teammates').then((r) => r.data),
    enabled: showTransfer,
    staleTime: 60_000,
  });

  const hangupServer = useMutation({
    mutationFn: () => marketingApi.post(`/telephony/calls/${callId}/hangup`),
    onSuccess: () => onCallEnded?.(),
    onError: (e: any) => toast.error(errMsg(e, t('webphone.controls.hangupFailed', 'Could not end the call'))),
  });

  const transfer = useMutation({
    mutationFn: (targetDahili: string) =>
      marketingApi.post(`/telephony/calls/${callId}/transfer`, { targetDahili, attended }),
    onSuccess: () => {
      toast.success(t('webphone.controls.transferSuccess', 'Call transferred'));
      setShowTransfer(false);
      onCallEnded?.();
    },
    onError: (e: any) => toast.error(errMsg(e, t('webphone.controls.transferFailed', 'Transfer failed'))),
  });

  if (!callId && !sipActive) return null;

  return (
    <div className="fixed bottom-44 right-3 z-50 flex flex-col items-end gap-2">
      {showKeypad && sipActive && (
        <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-border bg-surface p-3 shadow-lg">
          {DTMF_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => onDtmf(k)}
              className="h-9 w-9 rounded-md border border-border text-sm font-medium text-foreground hover:bg-muted"
            >
              {k}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-1.5 shadow-md">
        {sipActive && (
          <>
            <button
              type="button"
              title={held ? t('webphone.controls.unhold', 'Resume') : t('webphone.controls.hold', 'Hold')}
              aria-label={held ? t('webphone.controls.unhold', 'Resume') : t('webphone.controls.hold', 'Hold')}
              onClick={held ? onUnhold : onHold}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-full ${
                held ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {held ? <Play className="h-3.5 w-3.5" aria-hidden="true" /> : <Pause className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
            <button
              type="button"
              title={muted ? t('webphone.controls.unmute', 'Unmute') : t('webphone.controls.mute', 'Mute')}
              aria-label={muted ? t('webphone.controls.unmute', 'Unmute') : t('webphone.controls.mute', 'Mute')}
              onClick={muted ? onUnmute : onMute}
              className={`inline-flex h-7 w-7 items-center justify-center rounded-full ${
                muted ? 'bg-danger text-danger-foreground' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {muted ? <MicOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Mic className="h-3.5 w-3.5" aria-hidden="true" />}
            </button>
            <button
              type="button"
              title={t('webphone.controls.keypad', 'Keypad')}
              aria-label={t('webphone.controls.keypad', 'Keypad')}
              onClick={() => setShowKeypad((s) => !s)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
            >
              <Grid3x3 className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </>
        )}
        {callId && (
          <button
            type="button"
            title={t('webphone.controls.transfer', 'Transfer')}
            aria-label={t('webphone.controls.transfer', 'Transfer')}
            onClick={() => setShowTransfer(true)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
          >
            <PhoneForwarded className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
        {/* Bridge-mode-only server hangup — a SIP-active call already has the
            status pill's own "Kapat" button (instant, no round-trip). */}
        {callId && !sipActive && (
          <button
            type="button"
            title={t('webphone.controls.hangupServer', 'End call')}
            aria-label={t('webphone.controls.hangupServer', 'End call')}
            onClick={() => hangupServer.mutate()}
            disabled={hangupServer.isPending}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-danger text-danger-foreground hover:bg-danger/90 disabled:opacity-50"
          >
            <PhoneOff className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      <Dialog open={showTransfer} onOpenChange={setShowTransfer}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('webphone.controls.transferTitle', 'Transfer call')}</DialogTitle>
            <DialogDescription>
              {t('webphone.controls.transferHint', 'Pick a teammate to hand this call to.')}
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 text-caption text-foreground">
            <input
              type="checkbox"
              checked={attended}
              onChange={(e) => setAttended(e.target.checked)}
              className="h-4 w-4 rounded border-input"
            />
            {t('webphone.controls.attended', 'Attended (consult first)')}
          </label>
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {(teammates ?? []).length === 0 && (
              <p className="text-caption text-muted-foreground">
                {t('webphone.controls.noTeammates', 'No teammates with an extension yet')}
              </p>
            )}
            {(teammates ?? []).map((tm) => (
              <button
                key={tm.id}
                type="button"
                disabled={transfer.isPending}
                onClick={() => transfer.mutate(tm.dahili)}
                className="flex w-full items-center justify-between rounded-md border border-border px-3 py-2 text-left text-caption text-foreground hover:bg-muted disabled:opacity-50"
              >
                <span>{tm.firstName} {tm.lastName}</span>
                <span className="text-muted-foreground">{tm.dahili}</span>
              </button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTransfer(false)}>
              {t('webphone.controls.cancel', 'Cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
