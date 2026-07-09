import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Phone, PhoneCall, PhoneOff } from 'lucide-react';
import marketingApi from '../api/marketingApi';
import { useEntitlements } from '../hooks/useEntitlements';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { API_URL } from '../../../lib/env';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { createWebphone, type WebphoneState, type WebphoneConfig } from './webphone.store';
import CopilotPanel from './CopilotPanel';

/** The `screen_pop` event payload TelephonyEventConsumer pushes onto
 *  `GET /marketing/telephony/stream` (NetGSM Phase 3 Task 3). `lead` is
 *  trimmed server-side to a minimal card on an unrouted (broadcast) pop. */
interface ScreenPopPayload {
  customerNum: string | null;
  lead: { id: string; businessName?: string | null; contactPerson?: string | null } | null;
  salesCallId: string;
  internalNum: string | null;
}

/** A screen-pop is only "fresh enough" to merge into a SIP `ringing` state (or
 *  vice-versa) within this window — generous, since the webhook round-trip
 *  (santral -> outbox -> consumer -> SSE) is typically slower than the direct
 *  WSS INVITE, but events for two DIFFERENT calls should never merge. */
const SCREEN_POP_FRESHNESS_MS = 5_000;

/**
 * App-wide webphone host: mounted once in MarketingLayout so the rep's NetGSM
 * dahili stays REGISTERED on every page (not just the Telephony Settings panel).
 * That's what makes click-to-dial work — NetGSM `originate` rings the extension
 * first, and the webphone (registered here, auto-answering ONLY that ring-back —
 * see webphone.store.ts) picks it up and bridges the customer. Shows a small
 * status pill; surfaces an in-call hang-up.
 *
 * ALSO subscribes to the telephony screen-pop SSE stream (independent of
 * whether this rep even has a webphone configured — a bridge-mode rep with no
 * SIP leg still wants a heads-up toast for an inbound call) and correlates it
 * with the webphone's own SIP `ringing` state:
 *  - SIP `ringing` + a (recent) screen-pop → the ringing dialog shows the
 *    caller number AND the matched lead; Accept answers + navigates to the lead.
 *  - SIP `ringing` with NO screen-pop (yet) → the dialog still shows, with just
 *    the caller number the INVITE itself carried (may be blank).
 *  - A screen-pop with NO SIP `ringing` → there is no SIP leg for THIS host to
 *    answer (a bridge-mode inbound call rings the rep's real phone, not this
 *    browser tab) — an informational toast only, never an accept/reject dialog.
 */
export default function WebphoneHost() {
  const audioRef = useRef<HTMLAudioElement>(null);
  const wpRef = useRef<ReturnType<typeof createWebphone> | null>(null);
  const [state, setState] = useState<WebphoneState>({ status: 'idle' });
  const [screenPop, setScreenPop] = useState<ScreenPopPayload | null>(null);
  const pendingScreenPopRef = useRef<{ payload: ScreenPopPayload; at: number } | null>(null);
  const navigate = useNavigate();
  const { t } = useTranslation('marketing');
  const { accessToken } = useMarketingAuthStore();

  // Only reach for the webphone config when the workspace is entitled to
  // telephony — otherwise the FeatureGuard returns 403 and every page logs a
  // noisy console error for workspaces that don't use the phone at all.
  const { has } = useEntitlements();
  const telephonyEntitled = has('telephony');
  const { data: cfg } = useQuery<WebphoneConfig | null>({
    queryKey: ['marketing', 'telephony', 'webphone-config'],
    queryFn: () => marketingApi.get('/telephony/webphone-config').then((r) => r.data),
    staleTime: 5 * 60 * 1000,
    enabled: telephonyEntitled,
  });

  useEffect(() => {
    if (!cfg || !audioRef.current || wpRef.current) return;
    const wp = createWebphone(audioRef.current);
    wpRef.current = wp;
    const unsub = wp.subscribe((s) => {
      setState(s);
      if (s.status === 'ringing') {
        // A screen-pop that arrived just before this SIP INVITE (order isn't
        // guaranteed across the two channels) — merge it in now instead of
        // waiting for one that will never come.
        const pending = pendingScreenPopRef.current;
        if (pending && Date.now() - pending.at < SCREEN_POP_FRESHNESS_MS) setScreenPop(pending.payload);
      } else {
        setScreenPop(null);
      }
    });
    wp.start(cfg);
    return () => {
      unsub();
      wp.stop();
      wpRef.current = null;
    };
  }, [cfg]);

  // ── Screen-pop SSE (NetGSM Phase 3 Task 3/4) ──────────────────────────────
  // We deliberately do NOT use EventSource here (same reasoning as InboxPage's
  // conversations stream): it can't set an Authorization header, so the only
  // way to authenticate it would be leaking the access token into the query
  // string. Instead: fetch() + Bearer header, hand-parsed text/event-stream
  // frames, with a 3s reconnect — mirrors InboxPage's stream exactly.
  useEffect(() => {
    if (!telephonyEntitled || !accessToken) return;

    const controller = new AbortController();
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const handleFrame = (frame: string) => {
      const dataLines = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());
      if (dataLines.length === 0) return;
      try {
        const data = JSON.parse(dataLines.join('\n'));
        if (data?.kind !== 'screen_pop' || !data.payload) return;
        const payload = data.payload as ScreenPopPayload;
        pendingScreenPopRef.current = { payload, at: Date.now() };
        if (wpRef.current?.getState().status === 'ringing') {
          setScreenPop(payload);
        } else {
          // No SIP leg ringing on THIS device right now — either a bridge-mode
          // call (rings the rep's real phone, no webphone leg to answer here)
          // or the INVITE simply hasn't landed yet. Either way there's nothing
          // for this host to answer — surface it, never offer accept/reject.
          const caller =
            payload.lead?.businessName ||
            payload.lead?.contactPerson ||
            payload.customerNum ||
            t('webphone.incoming.unknown', 'Unknown caller');
          toast.info(t('webphone.bridgeToast', 'Incoming call: {{caller}}', { caller }));
        }
      } catch {
        /* ignore malformed frame */
      }
    };

    const connect = async () => {
      try {
        const res = await fetch(`${API_URL}/marketing/telephony/stream`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'text/event-stream',
          },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            if (frame.trim()) handleFrame(frame);
          }
        }
        if (!closed) scheduleReconnect();
      } catch {
        if (!closed) scheduleReconnect();
      }
    };

    const scheduleReconnect = () => {
      if (closed) return;
      reconnectTimer = setTimeout(connect, 3000);
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      controller.abort();
    };
  }, [accessToken, telephonyEntitled, t]);

  const handleAccept = async () => {
    const leadId = screenPop?.lead?.id;
    await wpRef.current?.answerIncoming();
    setScreenPop(null);
    if (leadId) navigate(`/leads/${leadId}`);
  };

  const handleReject = async () => {
    await wpRef.current?.rejectIncoming();
    setScreenPop(null);
  };

  const ringingDialog = state.status === 'ringing' && (
    <Dialog open onOpenChange={(open) => { if (!open) void handleReject(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('webphone.incoming.title', 'Incoming call')}</DialogTitle>
          <DialogDescription>
            {screenPop?.lead?.businessName ||
              screenPop?.lead?.contactPerson ||
              t('webphone.incoming.unknown', 'Unknown caller')}
          </DialogDescription>
        </DialogHeader>
        <p className="text-h3 font-display text-foreground">
          {screenPop?.customerNum ?? state.incoming?.number ?? t('webphone.incoming.noNumber', 'Number withheld')}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => void handleReject()}>
            <PhoneOff className="h-4 w-4" aria-hidden="true" />
            {t('webphone.incoming.reject', 'Reject')}
          </Button>
          <Button variant="primary" onClick={() => void handleAccept()}>
            <Phone className="h-4 w-4" aria-hidden="true" />
            {t('webphone.incoming.accept', 'Accept')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // The status pill / audio element / copilot need an actual webphone config;
  // the ringing dialog above is independent (its own effect gates on the
  // `telephony` feature only) and renders regardless.
  if (!cfg) return <>{ringingDialog}</>;

  const dot =
    state.status === 'registered' || state.status === 'incall'
      ? 'bg-green-500'
      : state.status === 'failed'
        ? 'bg-red-500'
        : state.status === 'ringing'
          ? 'bg-blue-500'
          : 'bg-amber-500';
  const label =
    state.status === 'incall'
      ? 'Görüşmede'
      : state.status === 'ringing'
        ? 'Çalıyor…'
        : state.status === 'registered'
          ? 'Telefon hazır'
          : state.status === 'registering'
            ? 'Bağlanıyor…'
            : state.status === 'failed'
              ? 'Telefon bağlanamadı'
              : 'Telefon';

  return (
    <>
      {ringingDialog}
      {/* Live-call copilot — only while a call is connected. Self-contained:
          listens to the rep's mic (Web Speech API) and surfaces AI suggestions. */}
      {state.status === 'incall' && (
        <div className="fixed bottom-32 right-3 z-50 w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-surface p-3 shadow-lg">
          <CopilotPanel />
        </div>
      )}
      {/* Stacked ABOVE the Ask-AI launcher (which lives at bottom-5 right-5) so the
          two fixed widgets never overlap each other. */}
      <div className="fixed bottom-20 right-3 z-50 flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 shadow-md">
        <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
        {state.status === 'incall' ? (
          <PhoneCall className="h-4 w-4 text-foreground" aria-hidden="true" />
        ) : (
          <Phone className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="text-caption text-foreground">{label}</span>
        {state.status === 'incall' && (
          <button
            type="button"
            onClick={() => wpRef.current?.hangup()}
            className="ml-1 inline-flex items-center gap-1 rounded-full bg-danger px-2 py-0.5 text-micro text-danger-foreground hover:bg-danger/90"
          >
            <PhoneOff className="h-3 w-3" aria-hidden="true" /> Kapat
          </button>
        )}
      </div>
      <audio ref={audioRef} autoPlay />
    </>
  );
}
