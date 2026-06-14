import { Controller, Get, Post, Param, Query, Body, Req, Res, NotFoundException } from '@nestjs/common';
import { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { SitesService } from '../sites/sites.service';
import { FormsService } from '../sites/forms.service';
import { BookingService } from '../sites/booking.service';
import { BookSlotDto, SlotsQueryDto } from '../dto/public-site.dto';

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
  async submit(@Param('formId') formId: string, @Body() body: Record<string, unknown>, @Res() res: Response): Promise<void> {
    // Dynamic-field form (schema is workspace-authored) — can't use a DTO, so
    // hard-cap the untrusted shape: ≤50 keys, key ≤100 chars, value ≤2000 chars.
    const safe: Record<string, string> = {};
    for (const [k, v] of Object.entries(body ?? {})) {
      if (Object.keys(safe).length >= 50) break;
      if (typeof k !== 'string' || k.length > 100) continue;
      safe[k] = String(v).slice(0, 2000);
    }
    let redirectUrl: string | null = null;
    try {
      ({ redirectUrl } = await this.forms.submit(formId, safe));
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
  async reserve(
    @Param('ws') ws: string, @Param('cal') cal: string,
    @Body() body: BookSlotDto,
  ) {
    const c = await this.booking.publicCalendar(ws, cal);
    return this.booking.book(ws, c.id, body);
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
      `<body><h2>${esc(info.name)}</h2><p>Times shown in UTC. Pick a slot:</p><div id="slots">Loading…</div>` +
      `<form id="f" style="display:none;margin-top:20px"><input name="name" placeholder="Name" required>` +
      `<input name="email" type="email" placeholder="Email"><input name="phone" placeholder="Phone">` +
      `<input type="hidden" name="start"><button type="submit">Confirm booking</button></form><div id="msg"></div>` +
      `<script>const B=${JSON.stringify(apiBase)};let f=document.getElementById('f');` +
      `fetch(B+'/slots').then(r=>r.json()).then(d=>{const s=document.getElementById('slots');s.innerHTML='';` +
      `(d.slots||[]).slice(0,60).forEach(t=>{const b=document.createElement('span');b.className='slot';b.textContent=new Date(t).toUTCString();` +
      `b.onclick=()=>{f.start.value=t;f.style.display='block';window.scrollTo(0,document.body.scrollHeight);};s.appendChild(b);});` +
      `if(!d.slots||!d.slots.length)s.textContent='No slots available.';});` +
      `f.onsubmit=e=>{e.preventDefault();const fd=new FormData(f);const body={};fd.forEach((v,k)=>body[k]=v);` +
      `fetch(B+'/reserve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})` +
      `.then(r=>r.ok?r.json():Promise.reject()).then(()=>{document.body.innerHTML='<h2>Booked! ✓</h2><p>Check your email for confirmation.</p>';})` +
      `.catch(()=>{document.getElementById('msg').textContent='That slot is no longer available — please pick another.';});};</script></body></html>`,
    );
  }
}
