import { SimpleUser } from 'sip.js/lib/platform/web';

export type WebphoneStatus = 'idle' | 'registering' | 'registered' | 'incall' | 'failed';
export interface WebphoneConfig {
  wssUrl: string; sipDomain: string; dahili: string; sipPassword: string; displayName?: string;
}
export interface WebphoneState { status: WebphoneStatus; error?: string; lastNumber?: string }

/**
 * Thin wrapper over SIP.js SimpleUser: register a rep's dahili to NetGSM's WSS
 * WebRTC endpoint, place outbound calls, AND auto-answer the inbound leg.
 *
 * Inbound auto-answer is what makes server-side click-to-dial (NetGSM `originate`
 * / dahili mode) actually connect: NetGSM rings the rep's extension FIRST (an
 * INVITE to this registered webphone) and only dials the customer once the
 * extension answers. Without an `onCallReceived` handler the INVITE was dropped,
 * so the extension "never rang" even though the PBX accepted the request.
 * `remoteAudio` is the <audio> element SIP.js renders the remote stream into.
 */
export function createWebphone(remoteAudio: HTMLAudioElement) {
  let user: SimpleUser | null = null;
  let domain = '';
  let state: WebphoneState = { status: 'idle' };
  const listeners = new Set<(s: WebphoneState) => void>();
  const set = (s: Partial<WebphoneState>) => { state = { ...state, ...s }; listeners.forEach((l) => l(state)); };

  /** Turkish-friendly digit normalisation, then a sip: target. */
  const toTarget = (raw: string) => `sip:${(raw ?? '').replace(/[^\d]/g, '')}@${domain}`;

  return {
    getState: () => state,
    subscribe(l: (s: WebphoneState) => void) { listeners.add(l); return () => listeners.delete(l); },

    async start(cfg: WebphoneConfig) {
      set({ status: 'registering', error: undefined });
      domain = cfg.sipDomain;
      try {
        user = new SimpleUser(cfg.wssUrl, {
          aor: `sip:${cfg.dahili}@${cfg.sipDomain}`,
          media: { remote: { audio: remoteAudio } },
          userAgentOptions: {
            authorizationUsername: cfg.dahili,
            authorizationPassword: cfg.sipPassword,
            displayName: cfg.displayName,
          },
          delegate: {
            // NetGSM originate rings the extension first — auto-answer it so the
            // rep is on the line when the customer leg connects (click-to-dial).
            onCallReceived: async () => {
              try {
                await user!.answer();
                set({ status: 'incall' });
              } catch (e: any) {
                set({ status: 'registered', error: e?.message ?? 'answer failed' });
              }
            },
            onCallHangup: () => set({ status: 'registered' }),
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
      await user.call(toTarget(number));
      set({ status: 'incall', lastNumber: number });
    },

    async hangup() {
      if (!user || state.status !== 'incall') return;
      try { await user.hangup(); } catch { /* already torn down */ }
      set({ status: 'registered' });
    },

    async stop() {
      try { await user?.unregister(); await user?.disconnect(); } catch { /* ignore */ }
      user = null; set({ status: 'idle' });
    },
  };
}
