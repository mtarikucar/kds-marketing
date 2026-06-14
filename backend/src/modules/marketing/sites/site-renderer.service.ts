import { Injectable } from '@nestjs/common';

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
/** Only allow http(s) hrefs (no javascript: / data:). */
function safeUrl(v: unknown): string {
  const s = String(v ?? '');
  return /^https?:\/\//i.test(s) || s.startsWith('/') ? esc(s) : '#';
}

interface FormDefLite {
  id: string;
  name: string;
  fields: Array<{ name: string; label?: string; type?: string; required?: boolean }>;
  redirectUrl?: string | null;
}

/**
 * Renders a SitePage's block list to a self-contained HTML document. ALL
 * customer-authored content is HTML-escaped and hrefs are http(s)-only — there
 * is NO inline JS and no template engine (no eval/handlebars), so a malicious
 * block can't inject script. Forms render as plain POST forms to the public
 * form endpoint (works with JS disabled).
 */
@Injectable()
export class SiteRendererService {
  render(
    page: { title: string; blocks: unknown; seo?: any; theme?: any },
    forms: Map<string, FormDefLite>,
    publicBase: string,
    branding?: { brandName?: string | null; accentColor?: string | null; logoUrl?: string | null },
  ): string {
    const theme = (page.theme ?? {}) as Record<string, string>;
    // Accent precedence: page theme → workspace branding → default.
    const accent = /^#[0-9a-fA-F]{3,8}$/.test(theme.accent ?? '')
      ? theme.accent
      : /^#[0-9a-fA-F]{6}$/.test(branding?.accentColor ?? '')
        ? branding!.accentColor!
        : '#1e40af';
    const seo = (page.seo ?? {}) as Record<string, string>;
    const blocks = Array.isArray(page.blocks) ? page.blocks : [];
    const header =
      branding && (branding.logoUrl || branding.brandName)
        ? `<header style="padding:14px 20px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:10px">` +
          (branding.logoUrl ? `<img src="${safeUrl(branding.logoUrl)}" alt="${esc(branding.brandName || '')}" style="height:32px">` : '') +
          (branding.brandName ? `<strong>${esc(branding.brandName)}</strong>` : '') +
          `</header>`
        : '';
    const body = header + blocks.map((b: any) => this.block(b, forms, publicBase, accent!)).join('\n');
    return (
      `<!doctype html><html lang="${esc(seo.lang || 'en')}"><head><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${esc(seo.title || page.title)}</title>` +
      (seo.description ? `<meta name="description" content="${esc(seo.description)}">` : '') +
      `<style>:root{--a:${accent}}*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,sans-serif;color:#0f172a;line-height:1.6}` +
      `.s{padding:56px 20px;max-width:960px;margin:0 auto}.hero{text-align:center}.hero h1{font-size:2.4rem;margin:0 0 12px}` +
      `.btn{display:inline-block;background:var(--a);color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600;border:none;cursor:pointer}` +
      `.grid{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}.card{border:1px solid #e2e8f0;border-radius:14px;padding:20px}` +
      `.price{font-size:2rem;font-weight:700;color:var(--a)}input,textarea{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;margin:6px 0;font:inherit}` +
      `label{font-size:.85rem;color:#475569;display:block;margin-top:8px}h2{font-size:1.6rem}</style></head><body>${body}</body></html>`
    );
  }

  private block(b: any, forms: Map<string, FormDefLite>, base: string, accent: string): string {
    switch (b?.type) {
      case 'hero':
        return `<section class="s hero"><h1>${esc(b.heading)}</h1><p>${esc(b.sub)}</p>` +
          (b.ctaText ? `<a class="btn" href="${safeUrl(b.ctaUrl)}">${esc(b.ctaText)}</a>` : '') + `</section>`;
      case 'features':
        return `<section class="s"><div class="grid">` +
          (b.items ?? []).map((it: any) => `<div class="card"><h3>${esc(it.title)}</h3><p>${esc(it.text)}</p></div>`).join('') +
          `</div></section>`;
      case 'pricing':
        return `<section class="s"><div class="grid">` +
          (b.plans ?? []).map((p: any) =>
            `<div class="card"><h3>${esc(p.name)}</h3><div class="price">${esc(p.price)}</div><ul>` +
            (p.features ?? []).map((f: any) => `<li>${esc(f)}</li>`).join('') + `</ul>` +
            (p.ctaUrl ? `<a class="btn" href="${safeUrl(p.ctaUrl)}">${esc(p.ctaText || 'Choose')}</a>` : '') + `</div>`,
          ).join('') + `</div></section>`;
      case 'faq':
        return `<section class="s"><h2>${esc(b.heading || 'FAQ')}</h2>` +
          (b.items ?? []).map((it: any) => `<div class="card"><strong>${esc(it.q)}</strong><p>${esc(it.a)}</p></div>`).join('') + `</section>`;
      case 'cta':
        return `<section class="s hero"><h2>${esc(b.heading)}</h2>` +
          (b.buttonText ? `<a class="btn" href="${safeUrl(b.buttonUrl)}">${esc(b.buttonText)}</a>` : '') + `</section>`;
      case 'text':
        return `<section class="s"><p>${esc(b.text)}</p></section>`;
      case 'form':
        return this.formBlock(b, forms.get(b.formId), base);
      default:
        return '';
    }
  }

  private formBlock(b: any, form: FormDefLite | undefined, base: string): string {
    if (!form) return '';
    const inputs = (form.fields ?? [])
      .map((f) => {
        const name = esc(f.name);
        const label = esc(f.label || f.name);
        const req = f.required ? 'required' : '';
        if (f.type === 'textarea') return `<label>${label}</label><textarea name="${name}" ${req}></textarea>`;
        const type = ['email', 'tel', 'number'].includes(f.type || '') ? f.type : 'text';
        return `<label>${label}</label><input type="${esc(type)}" name="${name}" ${req}>`;
      })
      .join('');
    return (
      `<section class="s"><h2>${esc(b.heading || form.name)}</h2>` +
      `<form method="POST" action="${base}/api/public/f/${esc(form.id)}">${inputs}` +
      `<button class="btn" type="submit" style="margin-top:12px">${esc(b.submitText || 'Submit')}</button></form></section>`
    );
  }
}
