import { NetgsmApiAdapter } from './netgsm-api.adapter';

describe('NetgsmApiAdapter', () => {
  const registry = { register: jest.fn() } as any;

  it('bridge mode (default): rings the rep phone + customer via callBridge', async () => {
    const client = { callBridge: jest.fn().mockResolvedValue({ ok: true, callId: 'u-7' }), originate: jest.fn() } as any;
    const a = new NetgsmApiAdapter(registry, client);
    const out = await a.prepareOutboundCall({
      toPhone: '+90 555 111 22 33', marketingUserId: 'u', crmId: 'call-1',
      config: { username: '850', password: 'pw', trunk: '8508407303', callMode: 'bridge', callerNum: '05321112233' },
    });
    expect(client.callBridge).toHaveBeenCalledWith(expect.objectContaining({
      caller: '05321112233', called: '+90 555 111 22 33', trunk: '8508407303', username: '850', password: 'pw', crmId: 'call-1',
    }));
    expect(client.originate).not.toHaveBeenCalled();
    expect(out).toMatchObject({ providerId: 'netgsm-netsantral', mode: 'api', externalCallId: 'u-7' });
  });

  it('bridge mode without the rep phone throws (no leg to ring)', async () => {
    const client = { callBridge: jest.fn(), originate: jest.fn() } as any;
    const a = new NetgsmApiAdapter(registry, client);
    await expect(a.prepareOutboundCall({
      toPhone: '5', marketingUserId: 'u',
      config: { username: '850', password: 'pw', trunk: '850', callMode: 'bridge' },
    })).rejects.toThrow();
    expect(client.callBridge).not.toHaveBeenCalled();
  });

  it('dahili mode: originates via the client and returns mode "api" with the call id', async () => {
    const client = { originate: jest.fn().mockResolvedValue({ ok: true, callId: 'u-9' }), callBridge: jest.fn() } as any;
    const a = new NetgsmApiAdapter(registry, client);
    const out = await a.prepareOutboundCall({
      toPhone: '+90 555 111 22 33', marketingUserId: 'u', crmId: 'call-2',
      config: { username: '850', password: 'pw', trunk: '8508407303', callMode: 'dahili', internalNum: '104' },
    });
    expect(client.originate).toHaveBeenCalledWith(expect.objectContaining({
      customer_num: '+90 555 111 22 33', internal_num: '104', trunk: '8508407303', crmId: 'call-2',
    }));
    expect(out).toMatchObject({ providerId: 'netgsm-netsantral', mode: 'api', externalCallId: 'u-9' });
  });

  it('throws a BadRequest when config is missing (no api-dial possible)', async () => {
    const a = new NetgsmApiAdapter(registry, { originate: jest.fn(), callBridge: jest.fn() } as any);
    await expect(a.prepareOutboundCall({ toPhone: '5', marketingUserId: 'u' })).rejects.toThrow();
  });

  it('throws when the provider rejects the call', async () => {
    const client = { callBridge: jest.fn().mockResolvedValue({ ok: false, code: '30', message: 'auth' }) } as any;
    const a = new NetgsmApiAdapter(registry, client);
    await expect(a.prepareOutboundCall({
      toPhone: '5', marketingUserId: 'u',
      config: { username: '850', password: 'pw', trunk: '850', callMode: 'bridge', callerNum: '0532' },
    })).rejects.toThrow(/auth|30/);
  });
});
