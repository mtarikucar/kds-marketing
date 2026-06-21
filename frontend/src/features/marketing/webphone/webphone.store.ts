import { SimpleUser } from 'sip.js/lib/platform/web';

export type WebphoneStatus = 'idle' | 'registering' | 'registered' | 'incall' | 'failed';
export interface WebphoneConfig {
  wssUrl: string; sipDomain: string; dahili: string; sipPassword: string; displayName?: string;
}
export interface WebphoneState { status: WebphoneStatus; error?: string; lastNumber?: string }

/**
 * Thin wrapper over SIP.js SimpleUser: register a rep's dahili to NetGSM's WSS
 * WebRTC endpoint and place an outbound call. Phase A — register + outbound only;
 * inbound + full controls come in Phase B. `remoteAudio` is the <audio> element
 * SIP.js renders the remote stream into.
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
          delegate: { onCallHangup: () => set({ status: 'registered' }) },
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
