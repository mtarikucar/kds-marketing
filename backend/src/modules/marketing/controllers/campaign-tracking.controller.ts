import { Controller, Get, Post, Param, Query, Res, Logger } from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { CampaignTrackingService } from '../campaigns/campaign-tracking.service';
import { ONE_CLICK_UNSUBSCRIBE_THROTTLE } from '../public-throttle.const';
import { MailLang, escapeHtml, t } from '../../../common/i18n/mail-copy';

// 1x1 transparent GIF.
const PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

const esc = escapeHtml;

const PAGE_STYLE =
  'font-family:system-ui;max-width:480px;margin:80px auto;text-align:center';

/** A token is a credential: only ever enough of it to correlate a log line. */
function tokenRef(token: string): string {
  return `${String(token ?? '').slice(0, 8)}…`;
}

/**
 * Public campaign tracking: open pixel, click redirect (open-redirect-safe —
 * only campaign-authored links resolve), and one-click unsubscribe. No auth —
 * gated by the unguessable per-recipient token.
 */
@Controller('public')
export class CampaignTrackingController {
  private readonly logger = new Logger(CampaignTrackingController.name);

  constructor(
    private readonly tracking: CampaignTrackingService,
    private readonly config: ConfigService,
  ) {}

  @Get('t/o/:token')
  async open(@Param('token') token: string, @Res() res: Response): Promise<void> {
    // The pixel must be returned whatever happens — a broken image in an inbox
    // is a worse outcome than a missed open — but a swallowed error that logs
    // nothing is how "opens stopped counting" goes unnoticed for weeks.
    await this.tracking.open(token).catch((e: any) => {
      this.logger.warn(`open tracking failed for ${tokenRef(token)}: ${e?.message ?? e}`);
    });
    res.set({ 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, no-cache, must-revalidate, private' });
    res.send(PIXEL);
  }

  @Get('t/c/:token')
  async click(
    @Param('token') token: string,
    @Query('i') i: string,
    @Res() res: Response,
  ): Promise<void> {
    // Same rule as the pixel: the recipient still gets taken somewhere, but the
    // failure is no longer invisible.
    const url = await this.tracking.click(token, Number(i) || 0).catch((e: any) => {
      this.logger.warn(`click tracking failed for ${tokenRef(token)}: ${e?.message ?? e}`);
      return null;
    });
    res.redirect(302, url ?? this.config.get<string>('PUBLIC_BASE_URL') ?? '/');
  }

  /**
   * Unsubscribe is a TWO-step (GET confirm → POST act) flow on purpose. A plain
   * GET that flipped the opt-out was unsafe: corporate mail security gateways
   * (Outlook Safe Links, Mimecast, Proofpoint…) and link-prefetching clients
   * fetch EVERY link in an email to scan it — silently unsubscribing real
   * recipients who never clicked. The GET now has no side effect (a scanner just
   * sees the page); the actual opt-out happens on the POST, which also serves
   * RFC 8058 List-Unsubscribe-Post=One-Click native unsubscribe.
   */
  @Get('u/:token')
  async unsubscribe(@Param('token') token: string, @Res() res: Response): Promise<void> {
    await this.confirmPage(token, 'u', res);
  }

  // Public state-changing write (flips the lead's opt-out + bumps the campaign
  // counter), so it carries a per-route throttle — its own bucket, because the
  // 20/min form bucket drops provider One-Click POSTs (see the constant).
  @Post('u/:token')
  @Throttle(ONE_CLICK_UNSUBSCRIBE_THROTTLE)
  async unsubscribeSubmit(@Param('token') token: string, @Res() res: Response): Promise<void> {
    await this.act(token, 'u', res);
  }

  /**
   * The same pair for mail that has no CampaignRecipient row — workflow/drip
   * sends, whose footer carries a signed LEAD-scoped token instead (R1). It is
   * a separate path only so the two token shapes are distinguishable in logs
   * and in a provider's records; both resolve through the same service, so a
   * campaign token posted here (or a lead token posted at `u/`) still works.
   */
  @Get('ul/:token')
  async leadUnsubscribe(@Param('token') token: string, @Res() res: Response): Promise<void> {
    await this.confirmPage(token, 'ul', res);
  }

  @Post('ul/:token')
  @Throttle(ONE_CLICK_UNSUBSCRIBE_THROTTLE)
  async leadUnsubscribeSubmit(@Param('token') token: string, @Res() res: Response): Promise<void> {
    await this.act(token, 'ul', res);
  }

  /**
   * The confirm form, posting back to the path it was reached on.
   *
   * `failed` re-renders the same button under the failure copy instead of the
   * invitation: the person still needs one press to retry, but a page that
   * looks identical to the one they just pressed is a page that says nothing
   * happened when something did (`unsubscribe-post-swallows`).
   */
  private async confirmPage(
    token: string,
    path: 'u' | 'ul',
    res: Response,
    known?: MailLang,
    failed = false,
  ): Promise<void> {
    const lang = known ?? (await this.lang(token));
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(
      this.page(
        lang,
        t(lang, failed ? 'unsubscribe.error.heading' : 'unsubscribe.confirm.heading'),
        t(lang, failed ? 'unsubscribe.error.body' : 'unsubscribe.confirm.body'),
        `<form method="POST" action="/api/public/${path}/${esc(token)}">` +
          `<button type="submit" style="background:#1e40af;color:#fff;border:none;padding:12px 28px;border-radius:10px;font-size:1rem;cursor:pointer">` +
          `${esc(t(lang, 'unsubscribe.confirm.button'))}</button></form>`,
      ),
    );
  }

  /**
   * The act. Three outcomes, three answers:
   *
   * - opted out → 200 and a confirmation;
   * - token we do not recognise → 200 and "link expired". Not our failure, and
   *   a 5xx here would have a provider redeliver a token that will never work;
   * - anything threw → **5xx**. It used to be a swallowed `.catch(() => false)`
   *   that rendered "link expired" over a lost opt-out with nothing in the log
   *   (`unsubscribe-post-swallows`). The 5xx is the only signal that makes
   *   Gmail/Yahoo retry a One-Click POST, and the only one error monitoring
   *   ever sees.
   */
  private async act(token: string, path: 'u' | 'ul', res: Response): Promise<void> {
    const lang = await this.lang(token);
    res.set('Content-Type', 'text/html; charset=utf-8');
    let ok: boolean;
    try {
      ok = await this.tracking.unsubscribe(token);
    } catch (e: any) {
      this.logger.error(
        `unsubscribe failed for ${tokenRef(token)} on /${path}: ${e?.message ?? e}`,
        e?.stack,
      );
      // The button again, under a 500 and under copy that says it failed: the
      // person can press it once more, and nothing on the page claims an
      // opt-out that did not happen. The language is reused rather than
      // re-resolved — whatever just failed is most likely the same database.
      res.status(500);
      await this.confirmPage(token, path, res, lang, true);
      return;
    }
    res.send(
      this.page(
        lang,
        t(lang, ok ? 'unsubscribe.done.heading' : 'unsubscribe.expired.heading'),
        t(lang, ok ? 'unsubscribe.done.body' : 'unsubscribe.expired.body'),
      ),
    );
  }

  /** Never throws: the page is rendered in English rather than not at all. */
  private async lang(token: string): Promise<MailLang> {
    return this.tracking.pageLang(token).catch(() => 'en' as MailLang);
  }

  private page(lang: MailLang, heading: string, body: string, extra = ''): string {
    return (
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${esc(t(lang, 'unsubscribe.page.title'))}</title>` +
      `<div style="${PAGE_STYLE}" lang="${esc(lang)}">` +
      `<h2>${esc(heading)}</h2>` +
      `<p style="color:#64748b">${esc(body)}</p>${extra}</div>`
    );
  }
}
