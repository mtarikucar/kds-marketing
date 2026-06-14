import { ForbiddenException } from '@nestjs/common';
import { VoiceAiService } from './voice-ai.service';
import { validTwilioSignature } from '../controllers/twilio-voice.controller';
import { createHmac } from 'crypto';

/**
 * Voice AI: the greeting opens the mic (<Gather>), a turn meters a credit and
 * returns the AI reply + re-opens the mic, and credit exhaustion hangs up. Plus
 * the Twilio request-signature check (the webhook trust boundary).
 */
describe('VoiceAiService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let anthropic: any;
  let credits: any;
  let svc: VoiceAiService;

  beforeEach(() => {
    prisma = {
      voiceCall: {
        upsert: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ id: 'vc1', status: 'IN_PROGRESS', workspaceId: WS, channelId: 'ch1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      voiceTranscript: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
      channel: { findFirst: jest.fn().mockResolvedValue({ agentProfileId: 'ag1' }) },
      agentProfile: { findFirst: jest.fn().mockResolvedValue({ persona: 'You are a receptionist.', language: 'tr', kbDocIds: [] }) },
      lead: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'lead1' }) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    anthropic = { isEnabled: jest.fn().mockReturnValue(true), complete: jest.fn().mockResolvedValue({ text: 'How can I help you?' }) };
    credits = { reserve: jest.fn(), refund: jest.fn() };
    const knowledge = { search: jest.fn().mockResolvedValue([]) };
    const autoAssigner = { pickAssignee: jest.fn().mockResolvedValue(null) };
    const config = { get: jest.fn().mockReturnValue('https://m.example') };
    svc = new VoiceAiService(prisma as any, config as any, anthropic as any, credits as any, knowledge as any, autoAssigner as any);
  });

  it('startCall greets + opens the mic + links a lead', async () => {
    const twiml = await svc.startCall({ id: 'ch1', workspaceId: WS, agentProfileId: 'ag1', configPublic: { greeting: 'Welcome to Acme!' } }, '+15551112233', '+15559999999', 'CA123');
    expect(twiml).toContain('<Gather');
    expect(twiml).toContain('Welcome to Acme!');
    expect(prisma.voiceCall.upsert).toHaveBeenCalled();
  });

  it('handleTurn meters a credit and returns the AI reply + re-opens the mic', async () => {
    const twiml = await svc.handleTurn('CA123', 'Do you have a table for two?');
    expect(credits.reserve).toHaveBeenCalledTimes(1);
    expect(twiml).toContain('How can I help you?');
    expect(twiml).toContain('<Gather');
    // both the customer turn and the AI turn were transcribed
    expect(prisma.voiceTranscript.create).toHaveBeenCalledTimes(2);
  });

  it('hangs up when AI credits are exhausted', async () => {
    credits.reserve.mockRejectedValue(new ForbiddenException({ code: 'AI_CREDITS_EXHAUSTED' }));
    const twiml = await svc.handleTurn('CA123', 'hello');
    expect(twiml).toContain('<Hangup/>');
    expect(twiml).not.toContain('<Gather');
  });

  it('reprompts (no credit) on empty speech', async () => {
    const twiml = await svc.handleTurn('CA123', '   ');
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(twiml).toContain('<Gather');
  });

  // --- BUG 10 REGRESSION: Twilio gather idempotency ---
  it('BUG 10: same callSid + same idempotency token twice → second call short-circuits (no second credit, no second transcript, turns not incremented again)', async () => {
    const token = 'idem-tok-001';

    // First call: the token claim succeeds (updateMany returns count=1).
    prisma.voiceCall.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const twiml1 = await svc.handleTurn('CA123', 'Hello there', token);
    expect(credits.reserve).toHaveBeenCalledTimes(1);
    expect(prisma.voiceTranscript.create).toHaveBeenCalledTimes(2); // CUSTOMER + AI
    expect(prisma.voiceCall.update).toHaveBeenCalledTimes(1); // turns incremented

    // Reset call counts between the two requests.
    jest.clearAllMocks();
    prisma.voiceCall.findUnique.mockResolvedValue({ id: 'vc1', status: 'IN_PROGRESS', workspaceId: WS, channelId: 'ch1' });

    // Second call: same token — updateMany returns count=0 (already claimed).
    prisma.voiceCall.updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const twiml2 = await svc.handleTurn('CA123', 'Hello there', token);

    // Short-circuit: no credit metered, no transcript written, turns not bumped.
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(prisma.voiceTranscript.create).not.toHaveBeenCalled();
    expect(prisma.voiceCall.update).not.toHaveBeenCalled();
    // Returns a valid TwiML response (not a hangup).
    expect(twiml2).toContain('<Response>');
  });

  describe('Twilio signature', () => {
    const token = 'tok-123';
    const url = 'https://m.example/api/public/channels/twilio/voice';
    const params = { CallSid: 'CA123', From: '+1', To: '+2' };
    const sign = () => {
      const data = url + Object.keys(params).sort().map((k) => k + (params as any)[k]).join('');
      return createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
    };

    it('accepts a correctly-signed request', () => {
      expect(validTwilioSignature(token, url, params, sign())).toBe(true);
    });
    it('rejects a tampered param', () => {
      expect(validTwilioSignature(token, url, { ...params, To: '+999' }, sign())).toBe(false);
    });
    it('rejects a wrong token', () => {
      expect(validTwilioSignature('other', url, params, sign())).toBe(false);
    });
  });
});
