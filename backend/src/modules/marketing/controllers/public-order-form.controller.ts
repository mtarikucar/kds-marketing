import { Controller, Get, Post, Param, Body, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { OrderFormsService } from '../order-forms/order-forms.service';
import { PublicOrderSubmitDto } from '../dto/order-form.dto';
import { PUBLIC_WRITE_THROTTLE } from '../public-throttle.const';
import { getClientIp } from '../../../common/helpers/client-ip.helper';

function esc(v: unknown): string {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
const money = (minor: number, cur: string) =>
  `${((minor || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })} ${cur}`;

/**
 * Public order-form page (no auth — gated by the unguessable form token). The
 * buyer enters their details and submits; the server creates a lead + invoice
 * and returns the pay URL, which the inline JS redirects to. The POST is rate-
 * limited (PUBLIC_WRITE_THROTTLE, 20/min/IP) — same as the form/booking public
 * writes. Mirrors the public invoice page.
 */
@Controller('public')
export class PublicOrderFormController {
  constructor(private readonly orderForms: OrderFormsService) {}

  @Get('o/:token')
  async page(@Param('token') token: string, @Res() res: Response): Promise<void> {
    let f: any;
    try {
      f = await this.orderForms.publicView(token);
    } catch {
      res.status(404).type('html').send('<h1>Order form not found</h1>');
      return;
    }
    const rows = (Array.isArray(f.items) ? f.items : [])
      .map(
        (it: any) =>
          `<tr><td>${esc(it.description)}</td><td style="text-align:right">${esc(it.qty)}</td><td style="text-align:right">${esc(money(it.unitPrice || 0, f.currency))}</td></tr>`,
      )
      .join('');
    res.type('html').send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${esc(f.name)}</title><style>body{font-family:system-ui;max-width:560px;margin:40px auto;padding:0 16px;color:#0f172a}` +
        `table{width:100%;border-collapse:collapse;margin:16px 0}td,th{padding:8px;border-bottom:1px solid #e2e8f0;text-align:left}` +
        `.total{font-size:1.3rem;font-weight:700;text-align:right;margin-bottom:16px}` +
        `label{display:block;margin:10px 0}input{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:1rem}` +
        `button{background:#1e40af;color:#fff;border:none;padding:14px 28px;border-radius:10px;cursor:pointer;font-size:1rem;width:100%}` +
        `#msg{text-align:center;margin-top:10px;color:#b91c1c}</style></head>` +
        `<body><h2>${esc(f.name)}</h2>` +
        (f.notes ? `<p style="color:#64748b">${esc(f.notes)}</p>` : '') +
        `<table><tr><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Price</th></tr>${rows}</table>` +
        `<div class="total">${esc(money(f.total, f.currency))}</div>` +
        `<form id="f"><label>Full name<input type="text" id="fullName" required maxlength="200"></label>` +
        `<label>Email<input type="email" id="email" maxlength="200"></label>` +
        (f.collectPhone
          ? `<label>Phone${f.phoneRequired ? ' *' : ''}<input type="text" id="phone" maxlength="40"${f.phoneRequired ? ' required' : ''}></label>`
          : '') +
        `<button type="button" id="go">Continue to payment</button><div id="msg"></div></form>` +
        `<script>var b=${JSON.stringify(`/api/public/o/${token}`)};` +
        `document.getElementById('go').onclick=function(){` +
        `var n=document.getElementById('fullName').value.trim();` +
        `if(!n){document.getElementById('msg').textContent='Please enter your name.';return;}` +
        `var p=document.getElementById('phone');` +
        `var payload={fullName:n,email:document.getElementById('email').value.trim()||undefined,phone:p&&p.value.trim()||undefined};` +
        `this.disabled=true;this.textContent='…';` +
        `fetch(b,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})` +
        `.then(function(r){return r.json();}).then(function(d){` +
        `if(d.redirectUrl){location.href=d.redirectUrl;}else{document.getElementById('msg').textContent=(d.message||'Could not continue. Please try again.');` +
        `document.getElementById('go').disabled=false;document.getElementById('go').textContent='Continue to payment';}});};</script>` +
        `</body></html>`,
    );
  }

  @Post('o/:token')
  @Throttle(PUBLIC_WRITE_THROTTLE)
  submit(
    @Param('token') token: string,
    @Body() body: PublicOrderSubmitDto,
    @Req() req: Request,
  ) {
    return this.orderForms.submit(token, body, {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });
  }
}
