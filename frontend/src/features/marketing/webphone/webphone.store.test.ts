import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const connect = vi.fn().mockResolvedValue(undefined);
const register = vi.fn().mockResolvedValue(undefined);
const call = vi.fn().mockResolvedValue(undefined);
const hangup = vi.fn().mockResolvedValue(undefined);
const answer = vi.fn().mockResolvedValue(undefined);
const decline = vi.fn().mockResolvedValue(undefined);
const hold = vi.fn().mockResolvedValue(undefined);
const unhold = vi.fn().mockResolvedValue(undefined);
const mute = vi.fn();
const unmute = vi.fn();
const sendDTMF = vi.fn().mockResolvedValue(undefined);
let captured: any;
let capturedInstance: any;
vi.mock('sip.js/lib/platform/web', () => ({
  SimpleUser: vi.fn().mockImplementation((server: string, opts: any) => {
    captured = { server, opts };
    capturedInstance = {
      connect, register, call, hangup, answer, decline, hold, unhold, mute, unmute, sendDTMF,
      unregister: vi.fn(), disconnect: vi.fn(), delegate: opts.delegate,
    };
    return capturedInstance;
  }),
}));

/** Simulate the INVITE's remote identity being available (see
 *  `inviteCallerNumber`'s doc in webphone.store.ts — it reaches the
 *  runtime-accessible, TypeScript-private `session` field). `undefined`
 *  (the default after `start()`) simulates the common "unavailable" case. */
const setInviteRemoteNumber = (num: string | undefined) => {
  capturedInstance.session = num ? { remoteIdentity: { uri: { user: num } } } : undefined;
};

import { createWebphone } from './webphone.store';

const cfg = { wssUrl: 'wss://sip5.netsantral.com:8089/ws', sipDomain: 'sip5.netsantral.com', dahili: '101', sipPassword: 'pw', displayName: 'A B' };

describe('webphone store', () => {
  beforeEach(() => {
    connect.mockClear(); register.mockClear(); call.mockClear(); hangup.mockClear();
    answer.mockClear(); decline.mockClear();
    hold.mockClear(); unhold.mockClear(); mute.mockClear(); unmute.mockClear(); sendDTMF.mockClear();
    connect.mockResolvedValue(undefined);
    answer.mockResolvedValue(undefined);
    decline.mockResolvedValue(undefined);
    hold.mockResolvedValue(undefined);
    unhold.mockResolvedValue(undefined);
    sendDTMF.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('builds the SimpleUser with the right server, AOR and auth, and registers', async () => {
    const wp = createWebphone(document.createElement('audio'));
    await wp.start(cfg);
    expect(captured.server).toBe('wss://sip5.netsantral.com:8089/ws');
    expect(captured.opts.aor).toBe('sip:101@sip5.netsantral.com');
    expect(captured.opts.userAgentOptions.authorizationUsername).toBe('101');
    expect(captured.opts.userAgentOptions.authorizationPassword).toBe('pw');
    expect(connect).toHaveBeenCalled();
    expect(register).toHaveBeenCalled();
    expect(wp.getState().status).toBe('registered');
  });

  it('dials a number as a sip: target on the domain', async () => {
    const wp = createWebphone(document.createElement('audio'));
    await wp.start(cfg);
    await wp.call('+90 555 111 22 33');
    expect(call).toHaveBeenCalledWith('sip:905551112233@sip5.netsantral.com');
    expect(wp.getState().status).toBe('incall');
  });

  it('reports failed status when connect rejects', async () => {
    connect.mockRejectedValueOnce(new Error('boom'));
    const wp = createWebphone(document.createElement('audio'));
    await wp.start(cfg);
    expect(wp.getState().status).toBe('failed');
  });

  it('reports failed status when register rejects (e.g. 401)', async () => {
    register.mockRejectedValueOnce(new Error('401'));
    const wp = createWebphone(document.createElement('audio'));
    await wp.start(cfg);
    expect(wp.getState().status).toBe('failed');
  });

  // ── Ring-back-only auto-answer (Phase 3 Task 4) ───────────────────────────

  it('does NOT auto-answer a genuine inbound INVITE (no recent outbound call)', async () => {
    const wp = createWebphone(document.createElement('audio'));
    await wp.start(cfg);

    await captured.opts.delegate.onCallReceived();

    expect(answer).not.toHaveBeenCalled();
    expect(wp.getState().status).toBe('ringing');
    expect(wp.getState().incoming).toEqual({ number: null });
  });

  it('auto-answers an INVITE that arrives within the ring-back window after call()', async () => {
    const wp = createWebphone(document.createElement('audio'));
    await wp.start(cfg);
    await wp.call('+90 555 111 22 33');
    call.mockClear(); // the ring-back INVITE isn't a new outbound call() — only assert on answer()

    await captured.opts.delegate.onCallReceived();

    expect(answer).toHaveBeenCalledTimes(1);
    expect(wp.getState().status).toBe('incall');
    expect(wp.getState().incoming).toBeUndefined();
  });

  it('does NOT auto-answer once the ring-back window has been consumed (clears on connect)', async () => {
    const wp = createWebphone(document.createElement('audio'));
    await wp.start(cfg);
    await wp.call('+90 555 111 22 33');

    await captured.opts.delegate.onCallReceived(); // consumes the window (the actual ring-back)
    answer.mockClear();

    await captured.opts.delegate.onCallReceived(); // a SECOND, unrelated inbound INVITE

    expect(answer).not.toHaveBeenCalled();
    expect(wp.getState().status).toBe('ringing');
  });

  it('does NOT auto-answer once the ring-back window has expired (clears on timeout)', async () => {
    vi.useFakeTimers();
    try {
      const wp = createWebphone(document.createElement('audio'));
      await wp.start(cfg);
      await wp.call('+90 555 111 22 33');

      vi.advanceTimersByTime(31_000); // past the 30s ring-back window

      await captured.opts.delegate.onCallReceived();

      expect(answer).not.toHaveBeenCalled();
      expect(wp.getState().status).toBe('ringing');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the ring-back window on hangup — a late INVITE after an early hangup is not auto-answered', async () => {
    const wp = createWebphone(document.createElement('audio'));
    await wp.start(cfg);
    await wp.call('+90 555 111 22 33');

    captured.opts.delegate.onCallHangup(); // outbound leg hung up before any ring-back arrived

    await captured.opts.delegate.onCallReceived();

    expect(answer).not.toHaveBeenCalled();
    expect(wp.getState().status).toBe('ringing');
  });

  // ── expectRingback() public method + number-matched correlation (H1/M2) ───

  it('expectRingback() arms the ring-back window independently of call() (REST-originated click-to-dial)', async () => {
    const wp = createWebphone(document.createElement('audio'));
    await wp.start(cfg);

    wp.expectRingback('+90 555 111 22 33'); // no wp.call() — the dial happened server-side via REST
    await captured.opts.delegate.onCallReceived();

    expect(call).not.toHaveBeenCalled(); // never placed a SIP INVITE ourselves
    expect(answer).toHaveBeenCalledTimes(1);
    expect(wp.getState().status).toBe('incall');
  });

  it('auto-answers when the INVITE remote identity matches the number armed via expectRingback()', async () => {
    const wp = createWebphone(document.createElement('audio'));
    await wp.start(cfg);
    wp.expectRingback('+90 555 111 22 33');
    setInviteRemoteNumber('905551112233'); // same number, different formatting — last-10 still matches

    await captured.opts.delegate.onCallReceived();

    expect(answer).toHaveBeenCalledTimes(1);
    expect(wp.getState().status).toBe('incall');
  });

  it('does NOT auto-answer a genuine inbound whose number does not match the number armed via expectRingback() (M2)', async () => {
    const wp = createWebphone(document.createElement('audio'));
    await wp.start(cfg);
    wp.expectRingback('+90 555 111 22 33');
    setInviteRemoteNumber('905559998877'); // a DIFFERENT, unrelated genuine inbound caller

    await captured.opts.delegate.onCallReceived();

    expect(answer).not.toHaveBeenCalled();
    expect(wp.getState().status).toBe('ringing');
    expect(wp.getState().incoming).toEqual({ number: '905559998877' });
  });

  it('a mismatched INVITE leaves the window armed for the real ring-back that follows (M2 residual)', async () => {
    const wp = createWebphone(document.createElement('audio'));
    await wp.start(cfg);
    wp.expectRingback('+90 555 111 22 33');
    setInviteRemoteNumber('905559998877'); // unrelated genuine inbound arrives first
    await captured.opts.delegate.onCallReceived();
    expect(answer).not.toHaveBeenCalled();

    setInviteRemoteNumber('905551112233'); // the actual ring-back arrives next, still inside the window
    await captured.opts.delegate.onCallReceived();

    expect(answer).toHaveBeenCalledTimes(1);
    expect(wp.getState().status).toBe('incall');
  });

  it('answerIncoming() answers a ringing genuine inbound call', async () => {
    const wp = createWebphone(document.createElement('audio'));
    await wp.start(cfg);
    await captured.opts.delegate.onCallReceived();
    expect(wp.getState().status).toBe('ringing');

    await wp.answerIncoming();

    expect(answer).toHaveBeenCalledTimes(1);
    expect(wp.getState().status).toBe('incall');
    expect(wp.getState().incoming).toBeUndefined();
  });

  it('rejectIncoming() declines a ringing genuine inbound call', async () => {
    const wp = createWebphone(document.createElement('audio'));
    await wp.start(cfg);
    await captured.opts.delegate.onCallReceived();
    expect(wp.getState().status).toBe('ringing');

    await wp.rejectIncoming();

    expect(decline).toHaveBeenCalledTimes(1);
    expect(wp.getState().status).toBe('registered');
    expect(wp.getState().incoming).toBeUndefined();
  });

  it('answerIncoming()/rejectIncoming() are no-ops when nothing is ringing', async () => {
    const wp = createWebphone(document.createElement('audio'));
    await wp.start(cfg);

    await wp.answerIncoming();
    await wp.rejectIncoming();

    expect(answer).not.toHaveBeenCalled();
    expect(decline).not.toHaveBeenCalled();
    expect(wp.getState().status).toBe('registered');
  });

  // ── In-call controls: hold/mute/DTMF (Phase 3 Task 5) ─────────────────────

  describe('hold/unhold', () => {
    it('hold() sends the re-INVITE and flips held:true while in a call', async () => {
      const wp = createWebphone(document.createElement('audio'));
      await wp.start(cfg);
      await wp.call('+90 555 111 22 33');

      await wp.hold();

      expect(hold).toHaveBeenCalledTimes(1);
      expect(wp.getState().held).toBe(true);
    });

    it('unhold() clears held:false', async () => {
      const wp = createWebphone(document.createElement('audio'));
      await wp.start(cfg);
      await wp.call('+90 555 111 22 33');
      await wp.hold();

      await wp.unhold();

      expect(unhold).toHaveBeenCalledTimes(1);
      expect(wp.getState().held).toBe(false);
    });

    it('hold()/unhold() are no-ops when not in a call', async () => {
      const wp = createWebphone(document.createElement('audio'));
      await wp.start(cfg);

      await wp.hold();
      await wp.unhold();

      expect(hold).not.toHaveBeenCalled();
      expect(unhold).not.toHaveBeenCalled();
    });

    it('RE-THROWS + sets error + leaves held unset when hold() rejects (so the caller can toast)', async () => {
      hold.mockRejectedValueOnce(new Error('re-INVITE rejected'));
      const wp = createWebphone(document.createElement('audio'));
      await wp.start(cfg);
      await wp.call('+90 555 111 22 33');

      // The rejection must PROPAGATE — WebphoneHost relies on it to toast; the
      // old silent swallow left the customer stuck on hold with no notice.
      await expect(wp.hold()).rejects.toThrow('re-INVITE rejected');
      expect(wp.getState().held).not.toBe(true); // button icon stays truthful
      expect(wp.getState().error).toBe('re-INVITE rejected');
    });

    it('RE-THROWS when unhold() rejects (a failed resume can leave the customer on hold)', async () => {
      const wp = createWebphone(document.createElement('audio'));
      await wp.start(cfg);
      await wp.call('+90 555 111 22 33');
      await wp.hold();
      unhold.mockRejectedValueOnce(new Error('resume rejected'));

      await expect(wp.unhold()).rejects.toThrow('resume rejected');
      expect(wp.getState().held).toBe(true); // still held — icon reflects reality
      expect(wp.getState().error).toBe('resume rejected');
    });

    it('a fresh call after hold resets held:false', async () => {
      const wp = createWebphone(document.createElement('audio'));
      await wp.start(cfg);
      await wp.call('+90 555 111 22 33');
      await wp.hold();
      expect(wp.getState().held).toBe(true);

      captured.opts.delegate.onCallHangup();
      await wp.call('+90 555 999 88 77');

      expect(wp.getState().held).toBe(false);
    });
  });

  describe('mute/unmute', () => {
    it('mute() disables the sender track and flips muted:true while in a call', async () => {
      const wp = createWebphone(document.createElement('audio'));
      await wp.start(cfg);
      await wp.call('+90 555 111 22 33');

      wp.mute();

      expect(mute).toHaveBeenCalledTimes(1);
      expect(wp.getState().muted).toBe(true);
    });

    it('unmute() clears muted:false', async () => {
      const wp = createWebphone(document.createElement('audio'));
      await wp.start(cfg);
      await wp.call('+90 555 111 22 33');
      wp.mute();

      wp.unmute();

      expect(unmute).toHaveBeenCalledTimes(1);
      expect(wp.getState().muted).toBe(false);
    });

    it('mute()/unmute() are no-ops when not in a call', async () => {
      const wp = createWebphone(document.createElement('audio'));
      await wp.start(cfg);

      wp.mute();
      wp.unmute();

      expect(mute).not.toHaveBeenCalled();
      expect(unmute).not.toHaveBeenCalled();
    });
  });

  describe('sendDtmf', () => {
    it('sends a DTMF tone while in a call', async () => {
      const wp = createWebphone(document.createElement('audio'));
      await wp.start(cfg);
      await wp.call('+90 555 111 22 33');

      await wp.sendDtmf('5');

      expect(sendDTMF).toHaveBeenCalledWith('5');
    });

    it('is a no-op when not in a call', async () => {
      const wp = createWebphone(document.createElement('audio'));
      await wp.start(cfg);

      await wp.sendDtmf('5');

      expect(sendDTMF).not.toHaveBeenCalled();
    });

    it('swallows a rejected sendDTMF (transient — nothing actionable to show)', async () => {
      sendDTMF.mockRejectedValueOnce(new Error('no active session'));
      const wp = createWebphone(document.createElement('audio'));
      await wp.start(cfg);
      await wp.call('+90 555 111 22 33');

      await expect(wp.sendDtmf('#')).resolves.toBeUndefined();
    });
  });

  it('hangup() resets held/muted back to false', async () => {
    const wp = createWebphone(document.createElement('audio'));
    await wp.start(cfg);
    await wp.call('+90 555 111 22 33');
    await wp.hold();
    wp.mute();

    await wp.hangup();

    expect(wp.getState().held).toBe(false);
    expect(wp.getState().muted).toBe(false);
  });
});
