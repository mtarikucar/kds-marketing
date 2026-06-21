import { TiktokDmAdapter } from './tiktok-dm.adapter';

describe('TiktokDmAdapter', () => {
  const registry = { register: jest.fn() } as any;
  const adapter = new TiktokDmAdapter(registry);

  it('registers itself on module init as TIKTOK', () => {
    adapter.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(adapter);
    expect(adapter.type).toBe('TIKTOK');
  });

  it('send is inert (FAILED, no throw) without an access token', async () => {
    const res = await adapter.send({
      config: { secrets: {}, externalId: 'biz-1' } as any,
      to: 'user-1',
      text: 'hi',
    });
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('access token');
  });

  it('parseInbound extracts a text DM and tags it TIKTOKID', () => {
    const config = { externalId: 'biz-1' } as any;
    const body = {
      data: {
        messages: [
          { from_user_id: 'u-9', message_id: 'm-1', text: 'merhaba', from_user_name: 'Ayşe' },
        ],
      },
    };
    const out = adapter.parseInbound(config, body);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      externalUserId: 'u-9',
      kind: 'TIKTOKID',
      externalMessageId: 'm-1',
      text: 'merhaba',
    });
  });

  it('parseInbound skips our own echoes (sender == connected business id)', () => {
    const config = { externalId: 'biz-1' } as any;
    const body = { data: { messages: [{ from_user_id: 'biz-1', message_id: 'm-2', text: 'echo' }] } };
    expect(adapter.parseInbound(config, body)).toHaveLength(0);
  });

  it('echo filter is type-robust — a NUMERIC sender id equal to the business id is still skipped', () => {
    const config = { externalId: '12345' } as any; // stored as string in the DB
    const body = { data: { messages: [{ from_user_id: 12345, message_id: 'm-3', text: 'echo' }] } };
    expect(adapter.parseInbound(config, body)).toHaveLength(0); // no reply loop
  });

  it('healthCheck is false without token/businessId', async () => {
    expect((await adapter.healthCheck({ secrets: {}, externalId: null } as any)).ok).toBe(false);
    expect(
      (await adapter.healthCheck({ secrets: { accessToken: 't' }, externalId: 'biz-1' } as any)).ok,
    ).toBe(true);
  });
});
