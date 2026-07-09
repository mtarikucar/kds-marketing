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
import CallControlsPanel from './CallControlsPanel';

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

/** mirrors the backend's own private `last10` helpers (e.g.
 *  telephony-event.consumer.ts, call-cdr-sync.service.ts) and
 *  webphone.store.ts's copy — last-10-digit comparison sidesteps
 *  +90/0/country-code formatting differences between the two channels
 *  (SIP INVITE vs. the screen-pop SSE payload). */
const last10 = (raw: string | null | undefined): string | null => {
  const d = (raw ?? '').replace(/[^\d]/g, '');
  return d.length ? d.slice(-10) : null;
};

/** True if either number is unknown (best-effort — can't rule out a match;
 *  mirrors the ring-back best-effort matching in webphone.store.ts) or both
 *  are known and their last-10 digits agree. False (never merge) only when
 *  BOTH are known and they disagree — that's the "foreign screen-pop" case
 *  Finding M3 targets: a broadcast pop meant for another rep's unrelated
 *  ringing call must not attach its lead card here. */
const numbersMayCorrelate = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const da = last10(a);
  const db = last10(b);
  return da === null || db === null || da === db;
};

/** App-wide singleton reference to the one mounted WebphoneHost's webphone
 *  instance (there is exactly one, mounted once in MarketingLayout — see the
 *  module doc below). Lets a REST-originated click-to-dial call site
 *  (ClickToDialButton's `/calls/start`, DialerPage's
 *  `/dialer/sessions/:id/dial`, both api-dial mode) that never touches the
 *  webphone store directly still arm the ring-back-expectation window before
 *  NetGSM's server-side `originate` rings the extension back — otherwise that
 *  ring-back INVITE surfaces the accept/reject dialog instead of
 *  auto-answering silently (see Finding H1 in task-4-report.md). `null`
 *  whenever no WebphoneHost is mounted (config not loaded yet, entitlement
 *  gate, or a unit test) — callers use `expectRingback` below, which just
 *  no-ops rather than throwing. */
let activeWebphone: { expectRingback: (dialedNumber?: string) => void } | null = null;

/**
 * Module-level pointer to the mounted WebphoneHost's own `activeCallId`
 * setter (Phase 3 Task 5 — in-call controls). Same idiom as `activeWebphone`
 * above: a REST-originated call (ClickToDialButton, DialerPage) knows the
 * SalesCall id the moment the server accepts the dial, well before — or, for
 * a bridge-mode call, INSTEAD of — any SIP ring-back ever arriving in this
 * tab. `setActiveCallId` lets those call sites hand that id to the one
 * mounted host so CallControlsPanel can show hangup/transfer immediately,
 * including for bridge calls that never touch this tab's SIP session at all.
 */
let activeCallIdSetter: ((id: string | null) => void) | null = null;

/** Arm the ring-back-expectation window on the one app-wide webphone
 *  instance, and (if known) record the SalesCall id as the active call for
 *  the in-call controls panel. No-op if no WebphoneHost is currently mounted. */
export function expectRingback(dialedNumber?: string, salesCallId?: string) {
  activeWebphone?.expectRingback(dialedNumber);
  if (salesCallId) activeCallIdSetter?.(salesCallId);
}

/** Directly set/clear the ACTIVE call shown in the in-call controls panel —
 *  for a call this rep is controlling that has no SIP leg in this tab
 *  (bridge-mode) or whose id is known before any ring-back. No-op if no
 *  WebphoneHost is currently mounted. */
export function setActiveCallId(id: string | null) {
  activeCallIdSetter?.(id);
}

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
  // NetGSM Phase 3 Task 5 — the SalesCall this rep is currently handling, for
  // CallControlsPanel (hangup/transfer/hold/mute/DTMF). Tracked independently
  // of the SIP `state.status` because a bridge-mode call never reaches
  // `incall` here at all (see `activeCallIdSetter`'s doc above).
  const [activeCallId, setActiveCallIdState] = useState<string | null>(null);
  const prevSipStatusRef = useRef<WebphoneState['status']>('idle');
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

  // Registers the activeCallId setter UNCONDITIONALLY (not gated on `cfg`) —
  // a bridge-mode rep (phone set, no dahili) never gets a webphone `cfg` at
  // all (webphoneConfigFor requires dahili+dahiliSecret), but still needs
  // ClickToDialButton/DialerPage's `setActiveCallId`/`expectRingback` calls
  // to reach this host so CallControlsPanel can show hangup/transfer.
  useEffect(() => {
    activeCallIdSetter = setActiveCallIdState;
    return () => { activeCallIdSetter = null; };
  }, []);

  useEffect(() => {
    if (!cfg || !audioRef.current || wpRef.current) return;
    const wp = createWebphone(audioRef.current);
    wpRef.current = wp;
    activeWebphone = wp;
    const unsub = wp.subscribe((s) => {
      setState(s);
      // A SIP call that just ended (was 'incall', now isn't) clears the
      // active-call pointer too — covers the dahili/inbound-accepted paths.
      // A bridge-mode call's activeCallId was never tied to a SIP transition
      // in the first place, so this never fires spuriously for it; it's
      // cleared instead by ClickToDialButton/DialerPage logging the outcome.
      if (prevSipStatusRef.current === 'incall' && s.status !== 'incall') {
        setActiveCallIdState(null);
      }
      prevSipStatusRef.current = s.status;
      if (s.status === 'ringing') {
        // A screen-pop that arrived just before this SIP INVITE (order isn't
        // guaranteed across the two channels) — merge it in now instead of
        // waiting for one that will never come. Freshness AND number-match
        // both required (Finding M3): a stale or FOREIGN screen-pop (meant for
        // another rep's unrelated ringing call, e.g. a broadcast pop) must
        // never attach its lead card to THIS ringing call.
        const pending = pendingScreenPopRef.current;
        if (
          pending &&
          Date.now() - pending.at < SCREEN_POP_FRESHNESS_MS &&
          numbersMayCorrelate(pending.payload.customerNum, s.incoming?.number)
        ) {
          setScreenPop(pending.payload);
          pendingScreenPopRef.current = null; // consumed — can't re-attach to a later call
        }
      } else {
        setScreenPop(null);
      }
    });
    wp.start(cfg);
    return () => {
      unsub();
      wp.stop();
      wpRef.current = null;
      activeWebphone = null;
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
        const sipState = wpRef.current?.getState();
        // Number-matched merge (Finding M3): only attach this screen-pop to
        // an already-ringing SIP call if the numbers correlate — otherwise a
        // broadcast pop for another rep's unrelated ringing call would attach
        // its lead card here (wrong lead shown; Accept navigates to the wrong
        // lead). A mismatch just falls through to the informational toast
        // below instead of the dialog merge.
        if (sipState?.status === 'ringing' && numbersMayCorrelate(payload.customerNum, sipState.incoming?.number)) {
          setScreenPop(payload);
          pendingScreenPopRef.current = null; // consumed — can't re-attach to a later call
        } else if (sipState?.status === 'ringing') {
          // Ringing, but this pop is for a DIFFERENT call (number mismatch) —
          // keep it pending (a still-fresh future ringing call it DOES match
          // may yet consume it) and ignore it for the current one.
          pendingScreenPopRef.current = { payload, at: Date.now() };
        } else {
          pendingScreenPopRef.current = { payload, at: Date.now() };
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
    const salesCallId = screenPop?.salesCallId ?? null;
    await wpRef.current?.answerIncoming();
    if (salesCallId) setActiveCallIdState(salesCallId);
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

  // In-call controls (Phase 3 Task 5) — independent of `cfg` like the ringing
  // dialog: a bridge-mode rep (phone set, no dahili) never gets a webphone
  // `cfg` at all, but still needs hangup/transfer for the live netsantral call.
  const callControlsPanel = (
    <CallControlsPanel
      callId={activeCallId}
      sipActive={state.status === 'incall'}
      held={!!state.held}
      muted={!!state.muted}
      onHold={() => void wpRef.current?.hold()}
      onUnhold={() => void wpRef.current?.unhold()}
      onMute={() => wpRef.current?.mute()}
      onUnmute={() => wpRef.current?.unmute()}
      onDtmf={(digit) => void wpRef.current?.sendDtmf(digit)}
      onCallEnded={() => setActiveCallIdState(null)}
    />
  );

  // The status pill / audio element / copilot need an actual webphone config;
  // the ringing dialog and in-call controls above are independent (their own
  // effects/props don't require it) and render regardless.
  if (!cfg) {
    return (
      <>
        {ringingDialog}
        {callControlsPanel}
      </>
    );
  }

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
      {callControlsPanel}
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
