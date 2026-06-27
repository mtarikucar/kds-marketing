import { Controller, Get, Post, Param, Body, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { DocumentsService } from '../documents/documents.service';
import { PublicSignDto } from '../dto/document.dto';
import { PUBLIC_WRITE_THROTTLE } from '../public-throttle.const';
import { getClientIp } from '../../../common/helpers/client-ip.helper';

function esc(v: unknown): string {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/**
 * Public e-signature page (no auth — gated by the unguessable document token).
 * The signer reviews the FROZEN body snapshot, types their full name, checks an
 * explicit consent box and signs (or declines). The body is rendered ESCAPED
 * with pre-wrap (plain text, no HTML injection); name/consent are escaped too.
 * Mirrors the public invoice/estimate pages.
 */
@Controller('public')
export class PublicDocumentController {
  constructor(private readonly documents: DocumentsService) {}

  @Get('d/:token')
  async page(@Param('token') token: string, @Res() res: Response): Promise<void> {
    let doc: any;
    try {
      doc = await this.documents.publicView(token);
    } catch {
      res.status(404).type('html').send('<h1>Document not found</h1>');
      return;
    }
    const signed = doc.status === 'SIGNED';
    const closed = doc.status === 'DECLINED' || doc.status === 'VOIDED';
    const banner = signed
      ? `<div class="ok">✓ Signed by ${esc(doc.signerName)} on ${esc(String(doc.signedAt).slice(0, 10))}</div>`
      : closed
        ? `<div class="no">This document is no longer available for signing.</div>`
        : '';
    res.type('html').send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${esc(doc.title)}</title><style>body{font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;color:#0f172a}` +
        `.body{border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:16px 0;max-height:55vh;overflow:auto;white-space:pre-wrap}` +
        `label{display:block;margin:12px 0}input[type=text],input[type=email]{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;font-size:1rem}` +
        `.consent{display:flex;gap:8px;align-items:flex-start;font-size:.9rem;color:#334155}` +
        `button{border:none;padding:14px 28px;border-radius:10px;cursor:pointer;font-size:1rem;margin:0 6px}` +
        `.sign{background:#16a34a;color:#fff}.decline{background:#fff;color:#b91c1c;border:1px solid #fecaca}` +
        `.ok{background:#dcfce7;color:#166534;padding:10px;border-radius:8px;text-align:center}` +
        `.no{background:#fef2f2;color:#991b1b;padding:10px;border-radius:8px;text-align:center}</style></head>` +
        `<body><h2>${esc(doc.title)}</h2>` +
        `<div class="body">${esc(doc.bodySnapshot)}</div>` +
        (signed || closed
          ? banner
          : `<form id="f"><label>Full legal name<input type="text" id="name" required maxlength="200"></label>` +
            `<label>Email (optional)<input type="email" id="email" maxlength="200"></label>` +
            `<label class="consent"><input type="checkbox" id="consent"><span>${esc(doc.consentStatement)}</span></label>` +
            `<div style="text-align:center;margin-top:16px"><button type="button" class="sign" id="ok">Sign</button>` +
            `<button type="button" class="decline" id="no">Decline</button></div>` +
            `<div id="msg" style="text-align:center;margin-top:12px;color:#334155"></div></form>` +
            `<script>var b=${JSON.stringify(`/api/public/d/${token}`)};` +
            `function done(t){document.getElementById('f').innerHTML='<div class="ok">'+t+'</div>';}` +
            `document.getElementById('ok').onclick=function(){` +
            `var n=document.getElementById('name').value.trim();var c=document.getElementById('consent').checked;` +
            `if(!n){document.getElementById('msg').textContent='Please type your full name.';return;}` +
            `if(!c){document.getElementById('msg').textContent='Please check the consent box.';return;}` +
            `this.disabled=true;fetch(b+'/sign',{method:'POST',headers:{'Content-Type':'application/json'},` +
            `body:JSON.stringify({signerName:n,signerEmail:document.getElementById('email').value.trim()||undefined,consent:c})})` +
            `.then(function(r){return r.json();}).then(function(d){d.status==='SIGNED'?done('✓ Thank you — signed.'):` +
            `(document.getElementById('msg').textContent='Could not sign. Please refresh.');});};` +
            `document.getElementById('no').onclick=function(){this.disabled=true;` +
            `fetch(b+'/decline',{method:'POST'}).then(function(r){return r.json();}).then(function(){done('Document declined.');});};</script>`) +
        `</body></html>`,
    );
  }

  @Post('d/:token/sign')
  @Throttle(PUBLIC_WRITE_THROTTLE)
  sign(@Param('token') token: string, @Body() body: PublicSignDto, @Req() req: Request) {
    return this.documents.publicSign(
      token,
      { signerName: body.signerName, signerEmail: body.signerEmail, consent: body.consent === true },
      { ip: getClientIp(req), userAgent: req.headers['user-agent'] },
    );
  }

  @Post('d/:token/decline')
  @Throttle(PUBLIC_WRITE_THROTTLE)
  decline(@Param('token') token: string) {
    return this.documents.publicDecline(token);
  }
}
