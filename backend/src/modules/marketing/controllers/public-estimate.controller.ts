import { Controller, Get, Post, Param, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { EstimatesService } from '../estimates/estimates.service';
import { PUBLIC_WRITE_THROTTLE } from '../public-throttle.const';

function esc(v: unknown): string {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
const money = (minor: number, cur: string) =>
  `${((minor || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })} ${cur}`;

/**
 * Public estimate accept/decline page (no auth — gated by the unguessable
 * estimate token). The customer reviews the line items and accepts or declines.
 * Trusted first-party HTML (inline JS ok), mirroring the public invoice page.
 */
@Controller('public')
export class PublicEstimateController {
  constructor(private readonly estimates: EstimatesService) {}

  @Get('e/:token')
  async page(@Param('token') token: string, @Res() res: Response): Promise<void> {
    let est: any;
    try {
      est = await this.estimates.publicView(token);
    } catch {
      res.status(404).type('html').send('<h1>Estimate not found</h1>');
      return;
    }
    const rows = (Array.isArray(est.items) ? est.items : [])
      .map(
        (it: any) =>
          `<tr><td>${esc(it.description)}</td><td style="text-align:right">${esc(it.qty)}</td><td style="text-align:right">${esc(money(it.unitPrice || 0, est.currency))}</td></tr>`,
      )
      .join('');
    const resolved = est.status === 'ACCEPTED' || est.status === 'DECLINED';
    const banner =
      est.status === 'ACCEPTED'
        ? `<div class="ok">✓ You accepted this estimate</div>`
        : est.status === 'DECLINED'
          ? `<div class="no">This estimate was declined</div>`
          : '';
    res.type('html').send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>Estimate ${esc(est.number)}</title><style>body{font-family:system-ui;max-width:560px;margin:40px auto;padding:0 16px;color:#0f172a}` +
        `table{width:100%;border-collapse:collapse;margin:16px 0}td,th{padding:8px;border-bottom:1px solid #e2e8f0;text-align:left}` +
        `.total{font-size:1.4rem;font-weight:700;text-align:right}button{border:none;padding:14px 28px;border-radius:10px;cursor:pointer;font-size:1rem;margin:0 6px}` +
        `.accept{background:#16a34a;color:#fff}.decline{background:#fff;color:#b91c1c;border:1px solid #fecaca}` +
        `.ok{background:#dcfce7;color:#166534;padding:10px;border-radius:8px;text-align:center}.no{background:#fef2f2;color:#991b1b;padding:10px;border-radius:8px;text-align:center}</style></head>` +
        `<body><h2>Estimate ${esc(est.number)}</h2>` +
        (est.validUntil
          ? `<p style="color:#64748b">Valid until ${esc(String(est.validUntil).slice(0, 10))}</p>`
          : '') +
        `<table><tr><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Price</th></tr>${rows}</table>` +
        `<div class="total">${esc(money(est.total, est.currency))}</div>` +
        (est.notes ? `<p style="color:#64748b">${esc(est.notes)}</p>` : '') +
        (resolved
          ? banner
          : `<div style="text-align:center;margin-top:20px"><button class="accept" id="ok">Accept</button><button class="decline" id="no">Decline</button></div><div id="msg" style="text-align:center;margin-top:12px"></div>` +
            `<script>var B=${JSON.stringify(`/api/public/e/${token}`)};` +
            `function act(p){var ok=document.getElementById('ok'),no=document.getElementById('no'),msg=document.getElementById('msg');` +
            `ok.disabled=true;no.disabled=true;` +
            `fetch(B+'/'+p,{method:'POST'}).then(function(r){return r.json();}).then(function(d){` +
            // Only treat it as done when the server actually confirms ACCEPTED/
            // DECLINED. A conflict (e.g. accepting an already-declined estimate)
            // returns {message,...} with no `status` — the old code mislabelled
            // that as "declined" and hid the buttons; now it shows the message
            // and re-enables. The .catch covers a network / non-JSON failure that
            // previously left both buttons disabled forever with no feedback.
            `if(d.status==='ACCEPTED'||d.status==='DECLINED'){msg.textContent=d.status==='ACCEPTED'?'✓ Thank you — accepted.':'Estimate declined.';` +
            `document.querySelector('div[style*=center]').style.display='none';}` +
            `else{msg.textContent=d.message||'Could not submit. Please try again.';ok.disabled=false;no.disabled=false;}})` +
            `.catch(function(){msg.textContent='Could not submit. Please check your connection and try again.';ok.disabled=false;no.disabled=false;});}` +
            `document.getElementById('ok').onclick=function(){act('accept');};document.getElementById('no').onclick=function(){act('decline');};</script>`) +
        `</body></html>`,
    );
  }

  @Post('e/:token/accept')
  @Throttle(PUBLIC_WRITE_THROTTLE)
  accept(@Param('token') token: string) {
    return this.estimates.publicAccept(token);
  }

  @Post('e/:token/decline')
  @Throttle(PUBLIC_WRITE_THROTTLE)
  decline(@Param('token') token: string) {
    return this.estimates.publicDecline(token);
  }
}
