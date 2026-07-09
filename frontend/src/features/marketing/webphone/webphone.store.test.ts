import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const connect = vi.fn().mockResolvedValue(undefined);
const register = vi.fn().mockResolvedValue(undefined);
const call = vi.fn().mockResolvedValue(undefined);
const hangup = vi.fn().mockResolvedValue(undefined);
const answer = vi.fn().mockResolvedValue(undefined);
const decline = vi.fn().mockResolvedValue(undefined);
let captured: any;
vi.mock('sip.js/lib/platform/web', () => ({
  SimpleUser: vi.fn().mockImplementation((server: string, opts: any) => {
    captured = { server, opts };
    return {
      connect, register, call, hangup, answer, decline,
      unregister: vi.fn(), disconnect: vi.fn(), delegate: opts.delegate,
    };
  }),
}));

import { createWebphone } from './webphone.store';

const cfg = { wssUrl: 'wss://sip5.netsantral.com:8089/ws', sipDomain: 'sip5.netsantral.com', dahili: '101', sipPassword: 'pw', displayName: 'A B' };

describe('webphone store', () => {
  beforeEach(() => {
    connect.mockClear(); register.mockClear(); call.mockClear(); hangup.mockClear();
    answer.mockClear(); decline.mockClear();
    connect.mockResolvedValue(undefined);
    answer.mockResolvedValue(undefined);
    decline.mockResolvedValue(undefined);
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
});
