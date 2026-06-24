import { Controller, Get, Post, Param, Body, Res, NotFoundException } from '@nestjs/common';
import { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ReviewsService } from '../reviews/reviews.service';
import { PUBLIC_WRITE_THROTTLE } from '../public-throttle.const';

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/**
 * Public rating gate (no auth — gated by the unguessable review token). ≥4
 * stars routes the customer to the public review site; <4 captures private
 * feedback. Trusted first-party HTML, so inline JS is fine.
 */
@Controller('public')
export class ReviewGateController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get('r/:token')
  page(@Param('token') token: string, @Res() res: Response): void {
    const api = `/api/public/r/${esc(token)}`;
    res.type('html').send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>Rate your experience</title><style>body{font-family:system-ui;max-width:480px;margin:60px auto;padding:0 16px;text-align:center}` +
      `.stars{font-size:2.6rem;cursor:pointer;user-select:none}.stars span{color:#cbd5e1;padding:2px}.stars span.on{color:#f59e0b}` +
      `textarea{width:100%;min-height:90px;padding:10px;border:1px solid #cbd5e1;border-radius:8px;margin:12px 0}` +
      `button{background:#1e40af;color:#fff;border:none;padding:12px 24px;border-radius:10px;cursor:pointer}</style></head>` +
      `<body><h2>How was your experience?</h2><div class="stars" id="s">` +
      [1, 2, 3, 4, 5].map((i) => `<span data-v="${i}">★</span>`).join('') + `</div>` +
      `<div id="fb" style="display:none"><textarea id="t" placeholder="Tell us what went wrong — we want to make it right."></textarea><button id="send">Send feedback</button></div>` +
      `<div id="done" style="display:none"><h3>Thank you! 🙏</h3></div>` +
      `<script>const API=${JSON.stringify(api)};let r=0;const s=document.getElementById('s');` +
      `s.querySelectorAll('span').forEach(el=>{el.onclick=()=>{r=+el.dataset.v;s.querySelectorAll('span').forEach(x=>x.classList.toggle('on',+x.dataset.v<=r));` +
      `if(r>=4){post('');}else{document.getElementById('fb').style.display='block';}};});` +
      `document.getElementById('send').onclick=()=>post(document.getElementById('t').value);` +
      `function post(text){fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rating:r,text})})` +
      `.then(x=>x.json()).then(d=>{if(d.redirectUrl&&/^https?:\\/\\//i.test(d.redirectUrl)){location.href=d.redirectUrl;}else{s.style.display='none';document.getElementById('fb').style.display='none';document.getElementById('done').style.display='block';}});}</script></body></html>`,
    );
  }

  @Post('r/:token')
  @Throttle(PUBLIC_WRITE_THROTTLE)
  async submit(@Param('token') token: string, @Body() body: { rating: number; text?: string; authorName?: string }) {
    if (!body || typeof body.rating !== 'number') throw new NotFoundException('Invalid rating');
    return this.reviews.submitRating(token, body.rating, body.text, body.authorName);
  }
}
