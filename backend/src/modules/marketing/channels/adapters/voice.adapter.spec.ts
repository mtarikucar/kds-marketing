import { VoiceAdapter } from './voice.adapter';

describe('VoiceAdapter.healthCheck (transport-aware)', () => {
  const adapter = new VoiceAdapter({ register: jest.fn() } as any);
  const orig = process.env.VOICE_AI_BRIDGE_SECRET;
  afterEach(() => {
    if (orig === undefined) delete process.env.VOICE_AI_BRIDGE_SECRET;
    else process.env.VOICE_AI_BRIDGE_SECRET = orig;
  });

  it('a Twilio channel (creds + number) is healthy regardless of the bridge secret', async () => {
    delete process.env.VOICE_AI_BRIDGE_SECRET;
    const r = await adapter.healthCheck({
      secrets: { accountSid: 'a', authToken: 'b' },
      externalId: '+15550001111',
      configPublic: {},
    } as any);
    expect(r.ok).toBe(true);
    expect(r.details?.transport).toBe('twilio');
  });

  it('a bridge-mode channel (no Twilio creds) is healthy ONLY when VOICE_AI_BRIDGE_SECRET is set', async () => {
    const cfg = { secrets: {}, externalId: null, configPublic: {} } as any;
    delete process.env.VOICE_AI_BRIDGE_SECRET;
    expect((await adapter.healthCheck(cfg)).ok).toBe(false);
    process.env.VOICE_AI_BRIDGE_SECRET = 'sekret';
    const r = await adapter.healthCheck(cfg);
    expect(r.ok).toBe(true);
    expect(r.details?.transport).toBe('bridge');
  });
});
