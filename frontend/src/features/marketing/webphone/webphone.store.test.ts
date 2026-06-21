import { describe, it, expect, vi, beforeEach } from 'vitest';

const connect = vi.fn().mockResolvedValue(undefined);
const register = vi.fn().mockResolvedValue(undefined);
const call = vi.fn().mockResolvedValue(undefined);
const hangup = vi.fn().mockResolvedValue(undefined);
let captured: any;
vi.mock('sip.js/lib/platform/web', () => ({
  SimpleUser: vi.fn().mockImplementation((server: string, opts: any) => {
    captured = { server, opts };
    return { connect, register, call, hangup, unregister: vi.fn(), disconnect: vi.fn(), delegate: opts.delegate };
  }),
}));

import { createWebphone } from './webphone.store';

const cfg = { wssUrl: 'wss://sip5.netsantral.com:8089/ws', sipDomain: 'sip5.netsantral.com', dahili: '101', sipPassword: 'pw', displayName: 'A B' };

describe('webphone store', () => {
  beforeEach(() => { connect.mockClear(); register.mockClear(); call.mockClear(); hangup.mockClear(); connect.mockResolvedValue(undefined); });

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
});
