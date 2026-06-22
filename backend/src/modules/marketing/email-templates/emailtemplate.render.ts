/**
 * Compiles an email template's block list into a table-based, inline-CSS HTML
 * document — the layout email clients (Outlook/Gmail) actually render. Like the
 * site renderer this is the trust boundary: ALL customer content is HTML-escaped
 * and hrefs/img-srcs are http(s)-only, with NO inline JS and no template engine,
 * so a malicious block can't inject script. Block types: heading, text, image,
 * button, divider, spacer, columns.
 */

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
/** Escape + preserve author line breaks as <br>. */
function escMultiline(v: unknown): string {
  return esc(v).replace(/\r?\n/g, '<br>');
}
/** Only http(s) / protocol-relative-safe URLs (no javascript: / data:). */
function safeUrl(v: unknown): string {
  const s = String(v ?? '');
  return /^https?:\/\//i.test(s) ? esc(s) : '#';
}
function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}
function px(v: unknown, def: number, max = 200): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : def;
}

export interface EmailBlock {
  type: string;
  [k: string]: unknown;
}
export interface EmailTheme {
  accent?: string;
  bg?: string;
}

export function renderEmailHtml(blocks: unknown, theme: EmailTheme = {}, preheader = ''): string {
  const accent = /^#[0-9a-fA-F]{6}$/.test(theme.accent ?? '') ? theme.accent! : '#1e40af';
  const bg = /^#[0-9a-fA-F]{6}$/.test(theme.bg ?? '') ? theme.bg! : '#f1f5f9';
  const rows = arr(blocks).map((b: any) => block(b && typeof b === 'object' ? b : { type: '' }, accent)).join('');
  const pre = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>`
    : '';
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0;padding:0;background:${bg};font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a">${pre}` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg}"><tr>` +
    `<td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden">` +
    rows +
    `</table></td></tr></table></body></html>`
  );
}

function block(b: any, accent: string): string {
  switch (b.type) {
    case 'heading':
      return cell(`<h1 style="margin:0;font-size:24px;line-height:1.3;color:#0f172a">${escMultiline(b.text)}</h1>`);
    case 'text':
      return cell(`<div style="font-size:15px;line-height:1.6;color:#334155">${escMultiline(b.text)}</div>`);
    case 'image':
      return `<tr><td style="padding:0"><img src="${safeUrl(b.url)}" alt="${esc(b.alt)}" width="600" style="width:100%;max-width:600px;display:block;border:0"></td></tr>`;
    case 'button':
      return `<tr><td align="${esc(b.align === 'left' ? 'left' : b.align === 'right' ? 'right' : 'center')}" style="padding:16px 24px">` +
        `<a href="${safeUrl(b.url)}" style="display:inline-block;background:${accent};color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">${esc(b.text || 'Click here')}</a></td></tr>`;
    case 'divider':
      return cell(`<hr style="border:0;border-top:1px solid #e2e8f0;margin:0">`, '8px 24px');
    case 'spacer':
      return `<tr><td style="height:${px(b.height, 24)}px;line-height:${px(b.height, 24)}px;font-size:0">&nbsp;</td></tr>`;
    case 'columns':
      return columns(b);
    default:
      return '';
  }
}

/** A standard content cell (padded). */
function cell(inner: string, padding = '14px 24px'): string {
  return `<tr><td style="padding:${padding}">${inner}</td></tr>`;
}

/** Two-column row: b.columns = [{ text }, { text }] (text-only, for layout). */
function columns(b: any): string {
  const cols = arr(b.columns).slice(0, 2);
  const w = cols.length === 2 ? '50%' : '100%';
  const tds = cols
    .map((c: any) => `<td valign="top" width="${w}" style="padding:14px 24px;font-size:15px;line-height:1.6;color:#334155">${escMultiline(c?.text)}</td>`)
    .join('');
  return `<tr><td style="padding:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${tds}</tr></table></td></tr>`;
}
