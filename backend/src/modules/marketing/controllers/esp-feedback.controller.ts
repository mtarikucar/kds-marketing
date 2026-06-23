import { Controller, Post, Req, Res, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { EspFeedbackService, FeedbackEvent } from '../channels/esp-feedback.service';

/**
 * ESP delivery-feedback webhook (bounces + spam complaints). A workspace points
 * its ESP's event webhook (SendGrid / Postmark / Mailgun) at this path; we verify
 * an HMAC-SHA256 over the RAW body against the platform-global ESP_FEEDBACK_SECRET
 * (a raw parser is mounted on this exact path in app.config.ts), ACK fast, then
 * suppress the bounced/complained addresses. INERT without ESP_FEEDBACK_SECRET
 * (401) — nothing runs until an operator sets it.
 */
@Controller('public/esp')
export class EspFeedbackController {
  private readonly logger = new Logger(EspFeedbackController.name);

  constructor(private readonly feedback: EspFeedbackService) {}

  @Post('feedback')
  receive(@Req() req: Request, @Res() res: Response): void {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
    if (!this.validSignature(raw, req.headers['x-esp-signature'])) {
      res.status(401).send('bad signature');
      return;
    }
    res.status(200).send('OK'); // ACK fast, then work
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      this.logger.warn('ESP feedback: unparseable JSON body — dropped');
      return;
    }
    const events = this.parseEvents(parsed);
    if (events.length) {
      this.feedback.suppress(events).catch((e) => this.logger.error(`ESP feedback failed: ${e?.message ?? e}`));
    }
  }

  /** Normalise SendGrid (array) / Postmark / Mailgun / generic shapes → suppressible events. */
  private parseEvents(body: unknown): FeedbackEvent[] {
    const out: FeedbackEvent[] = [];
    const push = (email: unknown, kind: FeedbackEvent['kind'] | null) => {
      const e = String(email ?? '').trim();
      if (e && kind) out.push({ email: e, kind });
    };
    const events = Array.isArray(body) ? body : [body];
    for (const ev of events) {
      const o = (ev ?? {}) as Record<string, any>;
      // SendGrid: { email, event: 'bounce'|'dropped'|'spamreport', type?: 'bounce'|'blocked' }
      if (typeof o.event === 'string') {
        const e = o.event.toLowerCase();
        if (e === 'spamreport') push(o.email, 'complaint');
        // SendGrid 'dropped' also covers sender-side causes (bad content / bad
        // SMTPAPI header) — only suppress when the reason is recipient-undeliverable.
        else if (e === 'dropped' && /bounced address|unsubscribed address|spam reporting address/i.test(String(o.reason ?? ''))) push(o.email, 'drop');
        // only HARD bounces suppress; SendGrid 'bounce' w/ type 'blocked' is a soft block
        else if (e === 'bounce' && (o.type ?? 'bounce').toLowerCase() !== 'blocked') push(o.email, 'bounce');
        else if (e === 'complained') push(o.email ?? o.recipient, 'complaint');
        continue;
      }
      // Postmark: { RecordType: 'Bounce'|'SpamComplaint', Email, Type }
      if (typeof o.RecordType === 'string') {
        const rt = o.RecordType.toLowerCase();
        if (rt === 'spamcomplaint') push(o.Email, 'complaint');
        else if (rt === 'bounce' && /hardbounce|badmailbox|blocked/i.test(String(o.Type ?? ''))) push(o.Email, 'bounce');
        continue;
      }
      // Mailgun: { 'event-data': { event: 'failed'|'complained', recipient, severity } }
      const ed = o['event-data'];
      if (ed && typeof ed === 'object') {
        const e = String(ed.event ?? '').toLowerCase();
        if (e === 'complained') push(ed.recipient, 'complaint');
        else if (e === 'failed' && String(ed.severity ?? '').toLowerCase() === 'permanent') push(ed.recipient, 'bounce');
        continue;
      }
      // Generic fallback: { email|recipient, type: 'bounce'|'complaint' }
      const t = String(o.type ?? '').toLowerCase();
      if (t === 'complaint' || t === 'bounce' || t === 'drop') push(o.email ?? o.recipient, t as FeedbackEvent['kind']);
    }
    return out;
  }

  private validSignature(raw: Buffer, sig: unknown): boolean {
    const secret = process.env.ESP_FEEDBACK_SECRET;
    if (!secret || typeof sig !== 'string') return false;
    const provided = sig.includes('s=') ? sig.split('s=').pop()!.trim() : sig.trim();
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    try {
      const a = Buffer.from(provided);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}
