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
/** Coerce a customer-controlled value to an array — blocks/fields are unvalidated
 *  JSON, so a non-array (e.g. items:"x") must NOT crash render() with `.map` of a
 *  non-function; it degrades to empty (matching the Array.isArray guard on blocks). */
function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

interface FormDefLite {
  id: string;
  name: string;
  fields: Array<{ name: string; label?: string; type?: string; required?: boolean; options?: string[] }>;
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
    const body = header + blocks.map((b: any, i: number) => this.block(b, forms, publicBase, accent!, i)).join('\n');
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
      `label{font-size:.85rem;color:#475569;display:block;margin-top:8px}h2{font-size:1.6rem}` +
      // JS-free, CSP-safe lead-capture popup (checkbox hack): the checkbox ships
      // `checked` so the modal shows on load; the × label unchecks it to close.
      // Adjacent `+` selector scopes each popup to its own overlay.
      `.pp-cb{position:absolute;left:-9999px}.pp-ov{display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:50;align-items:center;justify-content:center;padding:20px}` +
      `.pp-cb:checked+.pp-ov{display:flex}.pp-box{background:#fff;border-radius:16px;padding:32px;max-width:440px;width:100%;position:relative;text-align:center}` +
      `.pp-x{position:absolute;top:8px;right:14px;font-size:1.6rem;line-height:1;cursor:pointer;color:#94a3b8;text-decoration:none}` +
      `</style></head><body>${body}</body></html>`
    );
  }

  private block(b: any, forms: Map<string, FormDefLite>, base: string, accent: string, idx = 0): string {
    switch (b?.type) {
      case 'popup': {
        // JS-free modal shown on load (checkbox checked); the × closes it.
        const id = `pp${idx}`;
        return `<input type="checkbox" id="${id}" class="pp-cb" checked>` +
          `<div class="pp-ov"><div class="pp-box">` +
          `<label for="${id}" class="pp-x" aria-label="Close" role="button">&times;</label>` +
          `<h2>${esc(b.heading)}</h2>` +
          (b.text ? `<p>${esc(b.text)}</p>` : '') +
          (b.formId ? this.formBlock({ formId: b.formId, heading: '' }, forms.get(b.formId), base)
            : (b.ctaText ? `<a class="btn" href="${safeUrl(b.ctaUrl)}">${esc(b.ctaText)}</a>` : '')) +
          `</div></div>`;
      }
      case 'hero':
        return `<section class="s hero"><h1>${esc(b.heading)}</h1><p>${esc(b.sub)}</p>` +
          (b.ctaText ? `<a class="btn" href="${safeUrl(b.ctaUrl)}">${esc(b.ctaText)}</a>` : '') + `</section>`;
      case 'features':
        return `<section class="s"><div class="grid">` +
          arr(b.items).map((it: any) => `<div class="card"><h3>${esc(it?.title)}</h3><p>${esc(it?.text)}</p></div>`).join('') +
          `</div></section>`;
      case 'pricing':
        return `<section class="s"><div class="grid">` +
          arr(b.plans).map((p: any) =>
            `<div class="card"><h3>${esc(p?.name)}</h3><div class="price">${esc(p?.price)}</div><ul>` +
            arr(p?.features).map((f: any) => `<li>${esc(f)}</li>`).join('') + `</ul>` +
            (p?.ctaUrl ? `<a class="btn" href="${safeUrl(p.ctaUrl)}">${esc(p.ctaText || 'Choose')}</a>` : '') + `</div>`,
          ).join('') + `</div></section>`;
      case 'faq':
        return `<section class="s"><h2>${esc(b.heading || 'FAQ')}</h2>` +
          arr(b.items).map((it: any) => `<div class="card"><strong>${esc(it?.q)}</strong><p>${esc(it?.a)}</p></div>`).join('') + `</section>`;
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
    const inputs = arr(form.fields).map((f) => this.formField(f)).join('');
    return (
      `<section class="s"><h2>${esc(b.heading || form.name)}</h2>` +
      `<form method="POST" action="${base}/api/public/f/${esc(form.id)}">${inputs}` +
      `<button class="btn" type="submit" style="margin-top:12px">${esc(b.submitText || 'Submit')}</button></form></section>`
    );
  }

  /** Render one form field as a plain (JS-free) input. select/radio/checkbox use
   *  the field's `options` (escaped); checkbox with no options is a single
   *  consent box. Everything stays HTML-escaped — no script, no template engine. */
  private formField(f: { name: string; label?: string; type?: string; required?: boolean; options?: string[] }): string {
    const name = esc(f.name);
    const label = esc(f.label || f.name);
    const req = f.required ? 'required' : '';
    const opts = Array.isArray(f.options) ? f.options : [];
    const inline = 'style="width:auto;margin-right:6px"';
    switch (f.type) {
      case 'textarea':
        return `<label>${label}</label><textarea name="${name}" ${req}></textarea>`;
      case 'select':
        return `<label>${label}</label><select name="${name}" ${req}>` +
          `<option value="">—</option>` +
          opts.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('') +
          `</select>`;
      case 'radio':
        return `<label>${label}</label><div>` +
          opts.map((o) => `<label style="display:inline-flex;align-items:center;margin-right:14px"><input type="radio" name="${name}" value="${esc(o)}" ${req} ${inline}>${esc(o)}</label>`).join('') +
          `</div>`;
      case 'checkbox':
        if (opts.length) {
          return `<label>${label}</label><div>` +
            opts.map((o) => `<label style="display:inline-flex;align-items:center;margin-right:14px"><input type="checkbox" name="${name}" value="${esc(o)}" ${inline}>${esc(o)}</label>`).join('') +
            `</div>`;
        }
        return `<label style="display:inline-flex;align-items:center;margin-top:8px"><input type="checkbox" name="${name}" value="yes" ${req} ${inline}>${label}</label>`;
      case 'date':
        return `<label>${label}</label><input type="date" name="${name}" ${req}>`;
      default: {
        const type = ['email', 'tel', 'number'].includes(f.type || '') ? f.type : 'text';
        return `<label>${label}</label><input type="${esc(type)}" name="${name}" ${req}>`;
      }
    }
  }
}
