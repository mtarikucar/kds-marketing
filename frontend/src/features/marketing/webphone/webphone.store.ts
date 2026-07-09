import { SimpleUser } from 'sip.js/lib/platform/web';

export type WebphoneStatus = 'idle' | 'registering' | 'registered' | 'ringing' | 'incall' | 'failed';
export interface WebphoneConfig {
  wssUrl: string; sipDomain: string; dahili: string; sipPassword: string; displayName?: string;
}
/** A genuine (non-ring-back) inbound INVITE currently ringing, awaiting the
 *  rep's explicit accept/reject. `number` is best-effort (see
 *  `inviteCallerNumber` below) — the UI's real source of truth for the caller
 *  identity is the screen-pop SSE event (WebphoneHost correlates by time). */
export interface IncomingCall { number: string | null }
export interface WebphoneState {
  status: WebphoneStatus;
  error?: string;
  lastNumber?: string;
  incoming?: IncomingCall;
}

/** How long after this rep places an outbound `call()` an inbound INVITE is
 *  presumed to be its ring-back (NetGSM's dahili/API-mode originate rings the
 *  extension FIRST, then bridges the customer) rather than an unrelated
 *  genuine inbound call. */
const RINGBACK_WINDOW_MS = 30_000;

/**
 * Thin wrapper over SIP.js SimpleUser: register a rep's dahili to NetGSM's WSS
 * WebRTC endpoint, place outbound calls, and auto-answer ONLY the ring-back
 * leg of a call THIS rep just placed.
 *
 * Auto-answering that ring-back is what makes server-side click-to-dial (NetGSM
 * `originate` / dahili mode) actually connect: NetGSM rings the rep's extension
 * FIRST (an INVITE to this registered webphone) and only dials the customer
 * once the extension answers. A GENUINE inbound INVITE — no recent outbound
 * `call()` from this store — is NOT auto-answered: silently opening the mic to
 * an unconfirmed caller is a privacy hazard, so it instead flips `status` to
 * `ringing` and exposes `incoming` for the UI (WebphoneHost) to present an
 * explicit accept/reject affordance, correlating with the screen-pop SSE for
 * the caller's identity.
 * `remoteAudio` is the <audio> element SIP.js renders the remote stream into.
 */
export function createWebphone(remoteAudio: HTMLAudioElement) {
  let user: SimpleUser | null = null;
  let domain = '';
  let state: WebphoneState = { status: 'idle' };
  const listeners = new Set<(s: WebphoneState) => void>();
  const set = (s: Partial<WebphoneState>) => { state = { ...state, ...s }; listeners.forEach((l) => l(state)); };

  // Ring-back correlation window — a timestamp (not a boolean) so "cleared" and
  // "expired" are the same check (`ringbackUntil === null || Date.now() > ringbackUntil`).
  // `expectedDigits` is the last-10 of the number THIS rep just dialed (when
  // known) so the window is number-matched, not just time-matched (see M2 in
  // task-4-report.md): an unrelated genuine inbound landing inside the 30s
  // window must NOT be silently auto-answered just because the timing lines up.
  let ringbackUntil: number | null = null;
  let expectedDigits: string | null = null;
  /** mirrors the backend's own private `last10` helpers (e.g.
   *  telephony-event.consumer.ts, call-cdr-sync.service.ts) — last-10-digit
   *  comparison sidesteps +90/0/country-code formatting differences. */
  const last10 = (raw: string | null | undefined): string | null => {
    const d = (raw ?? '').replace(/[^\d]/g, '');
    return d.length ? d.slice(-10) : null;
  };
  const armRingbackWindow = (dialedNumber?: string) => {
    ringbackUntil = Date.now() + RINGBACK_WINDOW_MS;
    expectedDigits = last10(dialedNumber);
  };
  const clearRingbackWindow = () => { ringbackUntil = null; expectedDigits = null; };
  const isExpectingRingback = () => ringbackUntil !== null && Date.now() <= ringbackUntil;

  /** Turkish-friendly digit normalisation, then a sip: target. */
  const toTarget = (raw: string) => `sip:${(raw ?? '').replace(/[^\d]/g, '')}@${domain}`;

  /**
   * Best-effort caller number straight off the raw INVITE. SimpleUser's own
   * `onCallReceived` delegate signature drops the Invitation argument (see
   * sip.js's SimpleUserDelegate — `onCallReceived?(): void`), so there is no
   * OFFICIAL way to reach the remote identity from here. `SessionManager`
   * (SimpleUser's internal collaborator) does call the SimpleUser-internal
   * `onCallCreated(session)` — which stashes the session as `this.session` —
   * strictly BEFORE `onCallReceived()` fires, so by the time we're called the
   * (TypeScript-private, but runtime-accessible) `session` field IS the
   * Invitation, and `session.remoteIdentity.uri.user` is its caller number.
   * This reaches past SimpleUser's declared public surface, so it's wrapped
   * defensively and never trusted alone: WebphoneHost's screen-pop SSE
   * correlation is the reliable source for the caller card.
   */
  const inviteCallerNumber = (): string | null => {
    try {
      const withSession = user as unknown as { session?: { remoteIdentity?: { uri?: { user?: string } } } };
      return withSession.session?.remoteIdentity?.uri?.user ?? null;
    } catch {
      return null;
    }
  };

  return {
    getState: () => state,
    subscribe(l: (s: WebphoneState) => void) { listeners.add(l); return () => listeners.delete(l); },

    async start(cfg: WebphoneConfig) {
      set({ status: 'registering', error: undefined });
      domain = cfg.sipDomain;
      try {
        user = new SimpleUser(cfg.wssUrl, {
          aor: `sip:${cfg.dahili}@${cfg.sipDomain}`,
          media: {
            // Capture the mic (outbound audio) + render the remote leg into <audio>.
            // Without explicit constraints some browsers send no audio track.
            constraints: { audio: true, video: false },
            remote: { audio: remoteAudio },
          },
          userAgentOptions: {
            authorizationUsername: cfg.dahili,
            authorizationPassword: cfg.sipPassword,
            displayName: cfg.displayName,
            // SIP.js defaults to NO ICE servers (host candidates only) → behind
            // NAT the media never connects and the call has no audio either way.
            // STUN lets the browser discover its public (srflx) candidate so RTP
            // reaches NetGSM's gateway (which has a public IP).
            sessionDescriptionHandlerFactoryOptions: {
              iceGatheringTimeout: 3000,
              peerConnectionConfiguration: {
                iceServers: [
                  { urls: 'stun:stun.l.google.com:19302' },
                  { urls: 'stun:stun1.l.google.com:19302' },
                  { urls: 'stun:sip5.netsantral.com:3478' },
                ],
              },
            },
          },
          delegate: {
            // NetGSM originate rings the extension first — auto-answer ONLY that
            // ring-back (this rep placed an outbound `call()` in the last 30s),
            // so the rep is on the line when the customer leg connects
            // (click-to-dial). Any OTHER INVITE is a genuine inbound call this
            // rep did NOT initiate — never auto-answer it (mic-open privacy
            // hazard); surface it as `ringing` + `incoming` instead so the UI
            // can ask the rep to explicitly accept/reject.
            onCallReceived: async () => {
              if (isExpectingRingback()) {
                const remoteDigits = last10(inviteCallerNumber());
                // Match if we never learned the dialed number's digits, or the
                // INVITE's remote identity is unavailable (best-effort — see
                // `inviteCallerNumber`'s own doc on why that's often the case),
                // or the digits agree. An INVITE whose remote identity IS
                // available and DISAGREES is a genuine, unrelated inbound call
                // that happens to land inside the window — never auto-answer
                // it; fall through to the normal ringing/incoming path below,
                // leaving the window armed for the real ring-back that may
                // still follow.
                const isRingbackMatch = expectedDigits === null || remoteDigits === null || remoteDigits === expectedDigits;
                if (isRingbackMatch) {
                  // Single-use: consume the window on the first matching
                  // INVITE so a second, concurrent INVITE (e.g. two
                  // unavailable-identity calls inside the same window) is
                  // treated as a genuine inbound call, not auto-answered again.
                  clearRingbackWindow();
                  try {
                    await user!.answer();
                    set({ status: 'incall' });
                  } catch (e: any) {
                    set({ status: 'registered', error: e?.message ?? 'answer failed' });
                  }
                  return;
                }
              }
              set({ status: 'ringing', incoming: { number: inviteCallerNumber() } });
            },
            onCallHangup: () => {
              clearRingbackWindow();
              set({ status: 'registered', incoming: undefined });
            },
          },
        });
        await user.connect();
        await user.register();
        set({ status: 'registered' });
      } catch (e: any) {
        set({ status: 'failed', error: e?.message ?? 'register failed' });
      }
    },

    async call(number: string) {
      if (!user) throw new Error('webphone not started');
      // Arm the ring-back window BEFORE placing the call: NetGSM's dahili/
      // API-mode originate can ring the extension back almost immediately.
      armRingbackWindow(number);
      await user.call(toTarget(number));
      set({ status: 'incall', lastNumber: number });
    },

    /**
     * Publicly arm the ring-back-expectation window WITHOUT placing a SIP
     * `call()` — for a call THIS rep just originated via REST (POST
     * `/calls/start` or `/dialer/sessions/:id/dial`, Netsantral api-dial
     * mode). Those flows never touch this store's own `call()` (the browser
     * never places the SIP INVITE — NetGSM's `originate` rings the extension
     * server-side), so nothing else would arm this window for them, and the
     * extension ring-back would surface the accept/reject dialog instead of
     * auto-answering silently. `WebphoneHost` exposes a module-level
     * singleton so `ClickToDialButton` / `DialerPage` can reach the one
     * app-wide webphone instance and call this right after a successful
     * api-mode dial.
     */
    expectRingback(dialedNumber?: string) {
      armRingbackWindow(dialedNumber);
    },

    /** Accept a genuine inbound call the UI is showing (status `ringing`). */
    async answerIncoming() {
      if (!user || state.status !== 'ringing') return;
      try {
        await user.answer();
        set({ status: 'incall', incoming: undefined });
      } catch (e: any) {
        set({ status: 'registered', error: e?.message ?? 'answer failed', incoming: undefined });
      }
    },

    /** Reject a genuine inbound call the UI is showing (status `ringing`). */
    async rejectIncoming() {
      if (!user || state.status !== 'ringing') return;
      try { await user.decline(); } catch { /* already torn down */ }
      set({ status: 'registered', incoming: undefined });
    },

    async hangup() {
      if (!user || state.status !== 'incall') return;
      try { await user.hangup(); } catch { /* already torn down */ }
      set({ status: 'registered' });
    },

    async stop() {
      clearRingbackWindow();
      try { await user?.unregister(); await user?.disconnect(); } catch { /* ignore */ }
      user = null; set({ status: 'idle', incoming: undefined });
    },
  };
}
