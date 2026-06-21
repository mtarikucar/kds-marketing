import { NetgsmApiAdapter } from './netgsm-api.adapter';

describe('NetgsmApiAdapter', () => {
  const registry = { register: jest.fn() } as any;

  it('originates via the client and returns mode "api" with the call id', async () => {
    const client = { originate: jest.fn().mockResolvedValue({ ok: true, callId: 'u-9' }) } as any;
    const a = new NetgsmApiAdapter(registry, client);
    const out = await a.prepareOutboundCall({
      toPhone: '+90 555 111 22 33', marketingUserId: 'u',
      config: { username: '850', password: 'pw', trunk: '8508407303', internalNum: '104' },
    });
    expect(client.originate).toHaveBeenCalledWith(expect.objectContaining({
      customer_num: '+90 555 111 22 33', internal_num: '104', trunk: '8508407303', username: '850', password: 'pw',
    }));
    expect(out).toMatchObject({ providerId: 'netgsm-netsantral', mode: 'api', externalCallId: 'u-9' });
  });

  it('throws a BadRequest when config is missing (no api-dial possible)', async () => {
    const a = new NetgsmApiAdapter(registry, { originate: jest.fn() } as any);
    await expect(a.prepareOutboundCall({ toPhone: '5', marketingUserId: 'u' })).rejects.toThrow();
  });

  it('throws when the provider rejects the origination', async () => {
    const client = { originate: jest.fn().mockResolvedValue({ ok: false, code: '30', message: 'auth' }) } as any;
    const a = new NetgsmApiAdapter(registry, client);
    await expect(a.prepareOutboundCall({
      toPhone: '5', marketingUserId: 'u',
      config: { username: '850', password: 'pw', trunk: '850', internalNum: '104' },
    })).rejects.toThrow(/auth|30/);
  });
});
