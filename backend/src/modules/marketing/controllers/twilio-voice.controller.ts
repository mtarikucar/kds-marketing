import { Controller, Post, Req, Res, Headers, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { PublicChannelResolverService } from '../channels/public-channel-resolver.service';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { VoiceAiService } from '../channels/voice-ai.service';

/** Twilio's request-signature algorithm: base64(HMAC-SHA1(authToken, url + sorted k+v)). */
export function validTwilioSignature(authToken: string, url: string, params: Record<string, any>, signature: string): boolean {
  const data = url + Object.keys(params).sort().map((k) => k + (params[k] ?? '')).join('');
  const expected = createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

const TWIML_HANGUP = '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this line is not available.</Say><Hangup/></Response>';

/**
 * Public Twilio voice webhooks (no auth — verified by X-Twilio-Signature using
 * the channel's own authToken). The VOICE channel is resolved by the called
 * number (To); the gather/status hits resolve by CallSid. Returns TwiML.
 */
@Controller('public/channels/twilio')
export class TwilioVoiceController {
  private readonly logger = new Logger(TwilioVoiceController.name);

  constructor(
    private readonly resolver: PublicChannelResolverService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly voice: VoiceAiService,
    private readonly config: ConfigService,
  ) {}

  private fullUrl(req: Request): string {
    return `${this.config.get<string>('PUBLIC_BASE_URL') ?? ''}${req.originalUrl}`;
  }

  private verify(req: Request, authToken: string): boolean {
    const sig = req.headers['x-twilio-signature'];
    if (!this.config.get<string>('PUBLIC_BASE_URL')) {
      // Misconfiguration (not a forged request): the signature is computed over
      // the full public URL, so without PUBLIC_BASE_URL every Twilio webhook
      // fails verification. Surface it loudly so it isn't mistaken for an attack.
      this.logger.error(
        'PUBLIC_BASE_URL is not set — Twilio signature verification cannot run and ALL voice webhooks will be rejected. Set PUBLIC_BASE_URL to the public origin Twilio calls.',
      );
      return false;
    }
    if (typeof sig !== 'string') return false;
    return validTwilioSignature(authToken, this.fullUrl(req), req.body ?? {}, sig);
  }

  @Post('voice')
  async voiceWebhook(@Req() req: Request, @Res() res: Response): Promise<void> {
    const b = req.body ?? {};
    const channel = b.To ? await this.resolver.byExternalId('VOICE', String(b.To)) : null;
    if (!channel) { res.type('text/xml').send(TWIML_HANGUP); return; }
    const cfg = this.registry.resolveConfig(channel);
    if (!this.verify(req, cfg.secrets.authToken ?? '')) { res.status(403).send('bad signature'); return; }
    const twiml = await this.voice.startCall(channel as any, String(b.From ?? ''), String(b.To ?? ''), String(b.CallSid ?? ''));
    res.type('text/xml').send(twiml);
  }

  @Post('gather')
  async gather(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('i-twilio-idempotency-token') idempotencyToken?: string,
  ): Promise<void> {
    const b = req.body ?? {};
    const callSid = String(b.CallSid ?? '');
    const channel = await this.channelForCall(callSid);
    if (!channel) { res.type('text/xml').send(TWIML_HANGUP); return; }
    const cfg = this.registry.resolveConfig(channel);
    if (!this.verify(req, cfg.secrets.authToken ?? '')) { res.status(403).send('bad signature'); return; }
    const twiml = await this.voice.handleTurn(callSid, String(b.SpeechResult ?? ''), idempotencyToken);
    res.type('text/xml').send(twiml);
  }

  @Post('status')
  async status(@Req() req: Request, @Res() res: Response): Promise<void> {
    const b = req.body ?? {};
    const callSid = String(b.CallSid ?? '');
    const channel = await this.channelForCall(callSid);
    if (channel) {
      const cfg = this.registry.resolveConfig(channel);
      if (!this.verify(req, cfg.secrets.authToken ?? '')) { res.status(403).send('bad signature'); return; }
      await this.voice.endCall(callSid, String(b.CallStatus ?? '')).catch(() => undefined);
    }
    res.status(200).send('ok');
  }

  /** Resolve the VOICE channel a CallSid belongs to (via the VoiceCall row). */
  private async channelForCall(callSid: string) {
    if (!callSid) return null;
    return this.resolver.channelForVoiceCall(callSid);
  }
}
