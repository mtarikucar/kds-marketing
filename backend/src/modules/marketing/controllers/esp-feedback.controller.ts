import { Controller, Logger, Param, Post, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { EspFeedbackService, FeedbackEvent } from '../channels/esp-feedback.service';
import { getVerifier, WebhookVerifier } from '../channels/inbound/webhook-verifier';
import { WebhookReplayStore } from '../channels/inbound/webhook-verifier/webhook-replay.store';

/**
 * ESP delivery-feedback webhook (bounces + spam complaints).
 *
 * ## Two paths, one rule: the URL names the provider
 *
 * - `POST public/esp/feedback/:provider` — `sendgrid | mailgun | postmark |
 *   generic`. The verifier is chosen from the PATH, before a byte of the
 *   payload is parsed. Sniffing the body to decide "which ESP is this" would
 *   mean picking the verification rule out of the data being verified, and an
 *   attacker would simply post the shape whose secret is unset.
 * - `POST public/esp/feedback` — the original path, mapped to the generic HMAC
 *   relay and byte-for-byte unchanged, so an existing self-hosted relay keeps
 *   working.
 *
 * Each provider is INERT until its own operator secret is set (`esp-feedback-auth`):
 * with none of them set nothing here can suppress an address, and the answer is
 * 401 with a logged reason — never a 500, and never a silent accept. Until
 * an ESP is actually adopted, bounces arrive as DSNs in the tenant's own
 * mailbox and are handled there; this path is the ESP half only.
 *
 * A raw parser is mounted on `/api/public/esp/feedback` in `app.config.ts`, and
 * `app.use` matches by PREFIX — so `/feedback/:provider` is covered by the same
 * mount and `req.body` is the exact signed bytes on both paths.
 *
 * The work happens BEFORE the ACK: a 200 returned ahead of the write turns a
 * database blip into a permanently lost bounce, because the provider believes it
 * delivered. A failed write answers 5xx so the ESP redelivers.
 */
@Controller('public/esp')
export class EspFeedbackController {
  private readonly logger = new Logger(EspFeedbackController.name);

  constructor(
    private readonly feedback: EspFeedbackService,
    private readonly replay: WebhookReplayStore,
  ) {}

  /** The legacy relay path — generic HMAC, unchanged. */
  @Post('feedback')
  async receive(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.handle('generic', req, res);
  }

  /** One route per provider, so the verifier is picked before any parsing. */
  @Post('feedback/:provider')
  async receiveFrom(@Param('provider') provider: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.handle(provider, req, res);
  }

  private async handle(provider: string, req: Request, res: Response): Promise<void> {
    const verifier = getVerifier(provider);
    if (!verifier) {
      // No fallback verifier: an unrecognised segment is a 404, not an attempt
      // to guess which secret the caller meant.
      this.logger.warn(`ESP feedback: unknown provider "${String(provider).slice(0, 32)}" — dropped`);
      res.status(404).send('unknown provider');
      return;
    }

    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
    const verdict = verifier.verify({ rawBody: raw, headers: req.headers, ip: req.ip });
    if (!verdict.ok) {
      // Visible in OUR logs, not only in the provider's dashboard — a silent 401
      // is what made a misconfigured ESP cost an operator a day. The reason code
      // is machine-made; no signature or credential value is ever logged.
      this.logger.warn(`ESP feedback rejected (${verifier.provider}): ${verdict.reason}${this.hint(verifier, verdict.reason)}`);
      res.status(401).send('bad signature');
      return;
    }

    // One token, one body. Mailgun's signature covers `timestamp + token` and
    // NOT the payload, so a captured block would otherwise authenticate any
    // body an attacker liked for the whole 24-hour freshness window — including
    // a `failed`/`permanent` event that globally suppresses an address
    // (`mailgun-body-unsigned`). `replayToken` is unset for the verifiers that
    // sign the raw body, and this whole block is then a no-op.
    const token = verdict.replayToken;
    const bodyHash = token ? WebhookReplayStore.hashBody(raw) : '';
    if (token) {
      const seen = await this.replay.check(verifier.provider, token, bodyHash);
      if (seen.seen && !seen.sameBody) {
        this.logger.warn(
          `ESP feedback rejected (${verifier.provider}): signature token re-used with a DIFFERENT body — ` +
            'a captured signature block is being replayed',
        );
        res.status(401).send('bad signature');
        return;
      }
      if (seen.seen) {
        // The provider's own retry of a request we already applied. It must be
        // acknowledged, or it comes back for eight hours.
        res.status(200).send('OK');
        return;
      }
    }

    // A 2xx is the provider's cue to stop retrying, so the token is spent at
    // exactly the same moments — and never on the 500 path below, where the
    // retry is the thing that saves the event.
    const ok = async (): Promise<void> => {
      if (token) await this.replay.remember(verifier.provider, token, bodyHash);
      res.status(200).send('OK');
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      // Authenticated but unreadable: retrying cannot help, so this is a 200.
      this.logger.warn(`ESP feedback (${verifier.provider}): unparseable JSON body — dropped`);
      await ok();
      return;
    }

    const events = this.parseEvents(parsed);
    if (!events.length) {
      await ok();
      return;
    }

    try {
      const outcome = await this.feedback.suppress(events);
      if (outcome.failed > 0) {
        res.status(500).send('suppression failed');
        return;
      }
      await ok();
    } catch (e) {
      this.logger.error(`ESP feedback failed: ${(e as Error)?.message ?? e}`);
      res.status(500).send('suppression failed');
    }
  }

  /** Name the env key an operator still has to set — the honest half of a 401. */
  private hint(verifier: WebhookVerifier, reason: string): string {
    return reason === 'NOT_CONFIGURED' ? ` (set ${verifier.requires.join(' + ')})` : '';
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
}
