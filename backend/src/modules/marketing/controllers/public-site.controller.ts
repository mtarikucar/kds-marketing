import { Controller, Get, Post, Param, Query, Body, Req, Res, NotFoundException } from '@nestjs/common';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { SitesService } from '../sites/sites.service';
import { FormsService } from '../sites/forms.service';
import { BookingService } from '../sites/booking.service';
import { BookSlotDto, SlotsQueryDto, RescheduleTokenDto } from '../dto/public-site.dto';
import { TelephonyCallbackDto } from '../dto/telephony-callback.dto';
import { TelephonyCallbackService } from '../services/telephony-callback.service';
import { PUBLIC_WRITE_THROTTLE } from '../public-throttle.const';
import { readCookie, AFF_REF_COOKIE } from './public-referral.controller';

function callbackPage(title: string, heading: string, body: string): string {
  return (
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<div style="font-family:system-ui;max-width:480px;margin:80px auto;text-align:center">` +
    `<h2>${heading}</h2><p style="color:#64748b">${body}</p></div>`
  );
}

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/**
 * Public funnel surface (no auth): published page render, form submit (PRG),
 * and the booking slot-picker + reserve. Served under /api/public so it works
 * without the optional vanity-route nginx config (see ops/PUBLIC-ROUTES.md).
 */
@Controller('public')
export class PublicSiteController {
  constructor(
    private readonly sites: SitesService,
    private readonly forms: FormsService,
    private readonly booking: BookingService,
    private readonly config: ConfigService,
    private readonly callback: TelephonyCallbackService,
  ) {}

  private base(): string {
    return this.config.get<string>('PUBLIC_BASE_URL') ?? '';
  }

  @Get('p/:ws/:slug')
  async page(@Param('ws') ws: string, @Param('slug') slug: string, @Res() res: Response): Promise<void> {
    const html = await this.sites.renderPublic(ws, slug, this.base());
    if (!html) {
      res.status(404).type('html').send('<h1>404 — page not found</h1>');
      return;
    }
    res.type('html').send(html);
  }

  @Post('f/:formId')
  @Throttle(PUBLIC_WRITE_THROTTLE)
  async submit(@Param('formId') formId: string, @Body() body: Record<string, unknown>, @Req() req: Request, @Res() res: Response): Promise<void> {
    // Dynamic-field form (schema is workspace-authored) — can't use a DTO, so
    // hard-cap the untrusted shape: ≤50 keys, key ≤100 chars, value ≤2000 chars.
    const safe: Record<string, string> = {};
    for (const [k, v] of Object.entries(body ?? {})) {
      if (Object.keys(safe).length >= 50) break;
      if (typeof k !== 'string' || k.length > 100) continue;
      safe[k] = String(v).slice(0, 2000);
    }
    // First-touch attribution signals: the hosting page (Referer) carries the
    // UTM/click-id query; a hidden landing_url/page_url field wins if present.
    const referer = typeof req.headers.referer === 'string' ? req.headers.referer : undefined;
    const attributionCtx = { url: safe.landing_url || safe.page_url || referer, referrer: referer };
    let redirectUrl: string | null = null;
    try {
      ({ redirectUrl } = await this.forms.submit(formId, safe, readCookie(req, AFF_REF_COOKIE), attributionCtx));
    } catch {
      res.status(404).type('html').send('<h1>Form not found</h1>');
      return;
    }
    if (redirectUrl && /^https?:\/\//i.test(redirectUrl)) {
      res.redirect(302, redirectUrl);
    } else {
      res.type('html').send(
        `<!doctype html><meta charset="utf-8"><title>Thank you</title>` +
        `<div style="font-family:system-ui;max-width:480px;margin:80px auto;text-align:center">` +
        `<h2>Thank you!</h2><p style="color:#64748b">We received your submission and will be in touch.</p></div>`,
      );
    }
  }

  /**
   * "Leave your number, we call you now" (NetGSM Phase 5 Task 6) — the public
   * funnel/webchat 'callback' block's JS-free form target. `:ws` is the
   * workspace id, same convention as `p/:ws/:slug`/`funnel/:ws/:slug`. Calls
   * the EXACT SAME `TelephonyCallbackService.requestCallback` the
   * authenticated `POST /marketing/telephony/callback` uses, so a visitor-
   * submitted number is held to the identical İYS-mandatory, fail-closed
   * compliance gate as a rep-triggered callback — nothing here bypasses it.
   * Never leaks the underlying reason (İYS block, no PBX configured, ...)
   * to an anonymous visitor — a generic "try again later" either way.
   */
  @Post('callback/:ws')
  @Throttle(PUBLIC_WRITE_THROTTLE)
  async requestCallback(
    @Param('ws') ws: string,
    @Body() dto: TelephonyCallbackDto,
    @Res() res: Response,
  ): Promise<void> {
    try {
      await this.callback.requestCallback(ws, dto);
    } catch {
      res.status(400).type('html').send(
        callbackPage('Hata', 'Şu anda geri arama alamıyoruz', 'Lütfen daha sonra tekrar deneyin.'),
      );
      return;
    }
    res.type('html').send(
      callbackPage('Teşekkürler', 'Teşekkürler!', 'Sizi kısa süre içinde arayacağız.'),
    );
  }

  @Get('book/:ws/:cal/slots')
  async slots(
    @Param('ws') ws: string, @Param('cal') cal: string,
    @Query() q: SlotsQueryDto,
  ): Promise<{ calendarId: string; slots: string[] }> {
    const c = await this.booking.publicCalendar(ws, cal); // resolves slug → calendar
    const slots = await this.booking.availability(ws, c.id, q.from || new Date().toISOString(), q.to || new Date(Date.now() + 14 * 86400_000).toISOString());
    return { calendarId: c.id, slots };
  }

  @Post('book/:ws/:cal/reserve')
  @Throttle(PUBLIC_WRITE_THROTTLE)
  async reserve(
    @Param('ws') ws: string, @Param('cal') cal: string,
    @Body() body: BookSlotDto,
  ) {
    const c = await this.booking.publicCalendar(ws, cal);
    return this.booking.book(ws, c.id, body);
  }

  /** Public self-service: reschedule a booking by its opaque token. */
  @Post('book/token/:token/reschedule')
  @Throttle(PUBLIC_WRITE_THROTTLE)
  rescheduleByToken(@Param('token') token: string, @Body() body: RescheduleTokenDto) {
    return this.booking.rescheduleByToken(token, body.start);
  }

  /** Public self-service: cancel a booking by its opaque token. */
  @Post('book/token/:token/cancel')
  @Throttle(PUBLIC_WRITE_THROTTLE)
  cancelByToken(@Param('token') token: string) {
    return this.booking.cancelByToken(token);
  }

  @Get('book/:ws/:cal')
  async bookingPage(@Param('ws') ws: string, @Param('cal') cal: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    let info;
    try {
      info = await this.booking.publicCalendar(ws, cal);
    } catch {
      res.status(404).type('html').send('<h1>Calendar not found</h1>');
      return;
    }
    const apiBase = `${this.base()}/api/public/book/${esc(ws)}/${esc(cal)}`;
    // Trusted first-party HTML (our own markup) — inline JS is fine here.
    res.type('html').send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${esc(info.name)}</title><style>body{font-family:system-ui;max-width:560px;margin:40px auto;padding:0 16px}` +
      `.slot{display:inline-block;margin:4px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;cursor:pointer;background:#fff}` +
      `.slot:hover{border-color:#1e40af}input{display:block;width:100%;padding:10px;margin:6px 0;border:1px solid #cbd5e1;border-radius:8px}` +
      `button{background:#1e40af;color:#fff;border:none;padding:12px 20px;border-radius:10px;cursor:pointer}</style></head>` +
      `<body><h2>${esc(info.name)}</h2><p>Times shown in ${esc(info.timezone || 'UTC')}. Pick a slot:</p><div id="slots">Loading…</div>` +
      `<form id="f" style="display:none;margin-top:20px"><input name="name" placeholder="Name" required>` +
      `<input name="email" type="email" placeholder="Email"><input name="phone" placeholder="Phone">` +
      `<input type="hidden" name="start"><button type="submit">Confirm booking</button></form><div id="msg"></div>` +
      `<script>const B=${JSON.stringify(apiBase)};const TZ=${JSON.stringify(info.timezone || 'UTC')};let f=document.getElementById('f');` +
      `fetch(B+'/slots').then(r=>r.json()).then(d=>{const s=document.getElementById('slots');s.innerHTML='';` +
      `(d.slots||[]).slice(0,60).forEach(t=>{const b=document.createElement('span');b.className='slot';` +
      `b.textContent=new Date(t).toLocaleString(undefined,{timeZone:TZ,dateStyle:'medium',timeStyle:'short'});` +
      `b.onclick=()=>{f.start.value=t;f.style.display='block';window.scrollTo(0,document.body.scrollHeight);};s.appendChild(b);});` +
      `if(!d.slots||!d.slots.length)s.textContent='No slots available.';});` +
      `f.onsubmit=e=>{e.preventDefault();const fd=new FormData(f);const body={};fd.forEach((v,k)=>body[k]=v);` +
      `fetch(B+'/reserve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})` +
      `.then(r=>r.ok?r.json():Promise.reject()).then(()=>{document.body.innerHTML='<h2>Booked! ✓</h2><p>Check your email for confirmation.</p>';})` +
      `.catch(()=>{document.getElementById('msg').textContent='That slot is no longer available — please pick another.';});};</script></body></html>`,
    );
  }
}
