import { Body, Controller, Get, Post, Param, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { InvoicesService } from '../invoicing/invoices.service';
import { getClientIp } from '../../../common/helpers/client-ip.helper';

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
const money = (minor: number, cur: string) => `${(minor / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })} ${cur}`;

/**
 * Public invoice pay page (no auth — gated by the unguessable invoice token).
 * Payment runs through the workspace's own PSP: Stripe Checkout (redirect) or
 * manual bank-transfer instructions. Trusted first-party HTML (inline JS ok).
 */
@Controller('public')
export class PublicInvoiceController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get('i/:token')
  async page(@Param('token') token: string, @Res() res: Response): Promise<void> {
    let inv: any;
    try { inv = await this.invoices.publicInvoice(token); } catch { res.status(404).type('html').send('<h1>Invoice not found</h1>'); return; }
    const rows = (Array.isArray(inv.items) ? inv.items : [])
      .map((it: any) => `<tr><td>${esc(it.description)}</td><td style="text-align:right">${esc(it.qty)}</td><td style="text-align:right">${esc(money((it.unitPrice || 0), inv.currency))}</td></tr>`)
      .join('');
    const paid = inv.status === 'PAID';
    res.type('html').send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Invoice ${esc(inv.number)}</title><style>body{font-family:system-ui;max-width:560px;margin:40px auto;padding:0 16px;color:#0f172a}` +
      `table{width:100%;border-collapse:collapse;margin:16px 0}td,th{padding:8px;border-bottom:1px solid #e2e8f0;text-align:left}` +
      `.total{font-size:1.4rem;font-weight:700;text-align:right}button{background:#1e40af;color:#fff;border:none;padding:14px 28px;border-radius:10px;cursor:pointer;font-size:1rem}` +
      `.paid{background:#dcfce7;color:#166534;padding:10px;border-radius:8px;text-align:center}#manual{display:none;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-top:12px;white-space:pre-wrap}</style></head>` +
      `<body><h2>Invoice ${esc(inv.number)}</h2>` +
      `<table><tr><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Price</th></tr>${rows}</table>` +
      `<div class="total">${esc(money(inv.total, inv.currency))}</div>` +
      (inv.notes ? `<p style="color:#64748b">${esc(inv.notes)}</p>` : '') +
      (paid ? `<div class="paid">✓ Paid</div>` : `<div style="text-align:center;margin-top:20px"><button id="pay">Pay ${esc(money(inv.total, inv.currency))}</button></div><div id="manual"></div>`) +
      (paid ? '' : `<script>document.getElementById('pay').onclick=function(){var btn=this,lbl=btn.textContent;btn.disabled=true;btn.textContent='…';` +
        `fetch(${JSON.stringify(`/api/public/i/${token}/pay`)},{method:'POST'}).then(function(r){return r.json();}).then(function(d){` +
        `if(d.redirectUrl){location.href=d.redirectUrl;}else{var m=document.getElementById('manual');m.style.display='block';` +
        `m.textContent=typeof d.manual==='object'?Object.entries(d.manual).map(function(e){return e[0]+': '+e[1];}).join('\\n'):String(d.manual||'Contact us to pay.');btn.style.display='none';}})` +
        // Without this .catch a network / non-JSON failure (gateway 502, offline,
        // timeout) left the Pay button stuck on '…' disabled forever — the buyer
        // could neither pay nor retry. Re-enable it so they can try again.
        `.catch(function(){btn.disabled=false;btn.textContent=lbl;var m=document.getElementById('manual');m.style.display='block';m.textContent='Could not start payment. Please check your connection and try again.';});};</script>`) +
      `</body></html>`,
    );
  }

  /** PayTR notification (Bildirim URL) — verify + settle; PayTR needs a literal "OK". */
  @Post('i/paytr/callback')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async paytrCallback(@Body() body: Record<string, string>, @Res() res: Response): Promise<void> {
    let ok = false;
    try { ok = await this.invoices.paytrCallback(body); } catch { ok = false; }
    // PayTR retries until it receives the literal "OK"; reply OK once verified
    // (even on a non-success status, so it stops), FAIL only on an unmatched/forged hit.
    res.status(200).type('text/plain').send(ok ? 'OK' : 'FAIL');
  }

  @Post('i/:token/pay')
  pay(@Param('token') token: string, @Req() req: Request) {
    return this.invoices.pay(token, getClientIp(req));
  }

  /** Iyzico Checkout-Form callback — retrieve + settle, then show the result page. */
  @Post('i/:token/iyzico-callback')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async iyzicoCallback(@Param('token') token: string, @Body() body: Record<string, string>, @Res() res: Response): Promise<void> {
    let paid = false;
    try { paid = await this.invoices.iyzicoCallback(token, body?.token); } catch { paid = false; }
    res.type('html').send(
      `<!doctype html><meta charset="utf-8"><title>Payment</title><div style="font-family:system-ui;max-width:480px;margin:80px auto;text-align:center">` +
      `<h2>${paid ? 'Payment received ✓' : 'Payment pending'}</h2><p style="color:#64748b">${paid ? 'Thank you! Your invoice is now marked paid.' : 'We could not confirm the payment yet. If you completed checkout, it will update shortly.'}</p></div>`,
    );
  }

  @Get('i/:token/return')
  async stripeReturn(@Param('token') token: string, @Query('session_id') sessionId: string, @Res() res: Response): Promise<void> {
    let paid = false;
    try { ({ paid } = await this.invoices.stripeReturn(token, sessionId)); } catch { /* fall through */ }
    res.type('html').send(
      `<!doctype html><meta charset="utf-8"><title>Payment</title><div style="font-family:system-ui;max-width:480px;margin:80px auto;text-align:center">` +
      `<h2>${paid ? 'Payment received ✓' : 'Payment pending'}</h2><p style="color:#64748b">${paid ? 'Thank you! Your invoice is now marked paid.' : 'We could not confirm the payment yet. If you completed checkout, it will update shortly.'}</p></div>`,
    );
  }
}
