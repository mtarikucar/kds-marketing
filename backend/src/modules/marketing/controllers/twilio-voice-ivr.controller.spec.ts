import { createHmac } from 'crypto';
import { Request, Response } from 'express';
import { TwilioVoiceController } from './twilio-voice.controller';

/**
 * The IVR seam in the Twilio voice webhook: when a workspace has an ENABLED root
 * menu the inbound /voice hit is answered with the IVR <Gather>; when it does
 * NOT, the call falls through to the EXISTING AI flow (voice.startCall) — so
 * non-IVR workspaces are unaffected. The /ivr/:menuId callback maps the pressed
 * digit, and AI_RECEPTIONIST hands off to voice.startCall.
 */
describe('TwilioVoiceController — IVR routing', () => {
  const URL_BASE = 'https://m.example';
  const AUTH_TOKEN = 'tok-abc';
  const WS = 'ws-1';

  let resolver: any;
  let registry: any;
  let voice: any;
  let ivr: any;
  let config: any;
  let ctrl: TwilioVoiceController;

  const channel = { id: 'ch1', workspaceId: WS, type: 'VOICE', externalId: '+15559999999' };

  beforeEach(() => {
    resolver = { byExternalId: jest.fn().mockResolvedValue(channel) };
    registry = { resolveConfig: jest.fn().mockReturnValue({ secrets: { authToken: AUTH_TOKEN } }) };
    voice = { startCall: jest.fn().mockResolvedValue('<Response><Say>AI</Say></Response>') };
    ivr = {
      getEnabledRootMenu: jest.fn(),
      renderMenuTwiml: jest.fn().mockResolvedValue('<Response><Gather numDigits="1">menu</Gather></Response>'),
      handleDigit: jest.fn(),
    };
    config = { get: jest.fn().mockReturnValue(URL_BASE) };
    ctrl = new TwilioVoiceController(resolver, registry, voice, ivr, config);
  });

  // Build a req with a valid X-Twilio-Signature over the full URL + sorted params.
  const reqFor = (path: string, body: Record<string, string>): Request => {
    const url = `${URL_BASE}${path}`;
    const data = url + Object.keys(body).sort().map((k) => k + (body[k] ?? '')).join('');
    const sig = createHmac('sha1', AUTH_TOKEN).update(Buffer.from(data, 'utf8')).digest('base64');
    return {
      body,
      originalUrl: path,
      headers: { 'x-twilio-signature': sig },
    } as unknown as Request;
  };

  const resStub = () => {
    const res: any = {};
    res.type = jest.fn().mockReturnValue(res);
    res.status = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    return res as Response & { type: jest.Mock; status: jest.Mock; send: jest.Mock };
  };

  it('serves the IVR <Gather> when the workspace has an enabled root menu', async () => {
    ivr.getEnabledRootMenu.mockResolvedValue({ id: 'root-1' });
    const res = resStub() as any;
    await ctrl.voiceWebhook(reqFor('/api/public/channels/twilio/voice', { To: '+15559999999', From: '+1', CallSid: 'CA1' }), res);

    expect(ivr.renderMenuTwiml).toHaveBeenCalledWith(WS, 'root-1');
    expect(voice.startCall).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('<Gather numDigits="1">'));
  });

  it('falls through to the existing AI voice flow when NO enabled root menu (non-IVR workspace unaffected)', async () => {
    ivr.getEnabledRootMenu.mockResolvedValue(null);
    const res = resStub() as any;
    await ctrl.voiceWebhook(reqFor('/api/public/channels/twilio/voice', { To: '+15559999999', From: '+1', CallSid: 'CA1' }), res);

    expect(ivr.renderMenuTwiml).not.toHaveBeenCalled();
    expect(voice.startCall).toHaveBeenCalledWith(channel, '+1', '+15559999999', 'CA1');
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('<Say>AI</Say>'));
  });

  it('rejects an IVR digit callback with a bad signature (403)', async () => {
    const res = resStub() as any;
    const bad = {
      body: { To: '+15559999999', Digits: '1' },
      originalUrl: '/api/public/channels/twilio/ivr/root-1',
      headers: { 'x-twilio-signature': 'WRONG' },
    } as unknown as Request;
    await ctrl.ivrDigit('root-1', bad, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(ivr.handleDigit).not.toHaveBeenCalled();
  });

  it('maps a pressed digit to the next TwiML on the /ivr/:menuId callback', async () => {
    ivr.handleDigit.mockResolvedValue({ twiml: '<Response><Dial>+15551234567</Dial></Response>' });
    const res = resStub() as any;
    await ctrl.ivrDigit('root-1', reqFor('/api/public/channels/twilio/ivr/root-1', { To: '+15559999999', From: '+1', CallSid: 'CA1', Digits: '1' }), res);

    expect(ivr.handleDigit).toHaveBeenCalledWith(WS, 'root-1', '1');
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('<Dial>+15551234567</Dial>'));
    expect(voice.startCall).not.toHaveBeenCalled();
  });

  it('AI_RECEPTIONIST digit hands off to the existing voice.startCall flow', async () => {
    ivr.handleDigit.mockResolvedValue({ aiHandoff: true });
    const res = resStub() as any;
    await ctrl.ivrDigit('root-1', reqFor('/api/public/channels/twilio/ivr/root-1', { To: '+15559999999', From: '+1', CallSid: 'CA1', Digits: '0' }), res);

    expect(voice.startCall).toHaveBeenCalledWith(channel, '+1', '+15559999999', 'CA1');
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('<Say>AI</Say>'));
  });
});
