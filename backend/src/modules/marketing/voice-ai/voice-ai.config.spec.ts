import { isSttConfigured, isVoiceBridgeConfigured, isNetgsmIvrConfigured, voiceAiPublicStatus } from './voice-ai.config';

describe('voice-ai.config', () => {
  const OLD = process.env;
  beforeEach(() => { process.env = { ...OLD }; });
  afterAll(() => { process.env = OLD; });

  it('isSttConfigured true only with provider + key', () => {
    delete process.env.STT_PROVIDER; delete process.env.STT_API_KEY;
    expect(isSttConfigured()).toBe(false);
    process.env.STT_PROVIDER = 'deepgram'; process.env.STT_API_KEY = 'k';
    expect(isSttConfigured()).toBe(true);
  });

  it('isVoiceBridgeConfigured gates on shared secret', () => {
    delete process.env.VOICE_AI_BRIDGE_SECRET;
    expect(isVoiceBridgeConfigured()).toBe(false);
    process.env.VOICE_AI_BRIDGE_SECRET = 's';
    expect(isVoiceBridgeConfigured()).toBe(true);
  });

  it('isNetgsmIvrConfigured gates on token', () => {
    delete process.env.NETGSM_IVR_TOKEN;
    expect(isNetgsmIvrConfigured()).toBe(false);
    process.env.NETGSM_IVR_TOKEN = 't';
    expect(isNetgsmIvrConfigured()).toBe(true);
  });

  it('voiceAiPublicStatus reflects flags', () => {
    process.env.STT_PROVIDER = 'deepgram'; process.env.STT_API_KEY = 'k';
    process.env.VOICE_AI_BRIDGE_SECRET = 's'; delete process.env.NETGSM_IVR_TOKEN;
    const s = voiceAiPublicStatus();
    expect(s).toEqual({ stt: true, bridge: true, netgsmIvr: false, copilot: true });
  });
});
