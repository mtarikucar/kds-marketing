import { TEMPLATE_VARS, type TemplateLang } from '@/api/types';

// The template grammar and the fixed footer, as `jt_outreach::template` and `jt_outreach::footer`
// define them, for the editor's live preview only: the server parses and renders every send
// itself, and a save it refuses is refused whatever the preview showed.

/** A piece of a parsed subject or body. */
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'var'; name: string; fallback: string | null };

/** Why a template does not parse (`jt_outreach::TemplateError` reasons). */
export type TemplateProblem =
  | { reason: 'unbalanced_braces' }
  | { reason: 'unknown_variable'; name: string }
  | { reason: 'custom_key' }
  | { reason: 'fallback_invalid' }
  | { reason: 'literal_invalid' };

const MAX_FALLBACK_CHARS = 80;
const CUSTOM_KEY = /^[a-z0-9_]{1,32}$/;

function knownVar(name: string): TemplateProblem | null {
  if ((TEMPLATE_VARS as readonly string[]).includes(name)) return null;
  if (name.startsWith('custom.')) return CUSTOM_KEY.test(name.slice('custom.'.length)) ? null : { reason: 'custom_key' };
  return { reason: 'unknown_variable', name: name.slice(0, 64) };
}

/** `s` as segments, or the first problem, as `jt_outreach::template::parse` reads it. */
export function parseTemplate(s: string): { ok: true; segments: Segment[] } | { ok: false; problem: TemplateProblem } {
  const segments: Segment[] = [];
  let rest = s;
  for (;;) {
    const open = rest.indexOf('{{');
    const close = rest.indexOf('}}');
    if (open < 0 && close < 0) {
      if (rest) segments.push({ kind: 'text', text: rest });
      return { ok: true, segments };
    }
    if (open < 0 || (close >= 0 && close < open)) return { ok: false, problem: { reason: 'unbalanced_braces' } };
    if (open > 0) segments.push({ kind: 'text', text: rest.slice(0, open) });
    const after = rest.slice(open + 2);
    if (after.startsWith('"')) {
      const literal = after.slice(1);
      const end = literal.indexOf('"}}');
      if (end < 0) return { ok: false, problem: { reason: 'unbalanced_braces' } };
      const text = literal.slice(0, end);
      if (!text || [...text].length > MAX_FALLBACK_CHARS || ![...text].every((c) => c === '{' || c === '}')) {
        return { ok: false, problem: { reason: 'literal_invalid' } };
      }
      segments.push({ kind: 'text', text });
      rest = literal.slice(end + 3);
      continue;
    }
    const end = after.indexOf('}}');
    if (end < 0) return { ok: false, problem: { reason: 'unbalanced_braces' } };
    const inner = after.slice(0, end);
    const bar = inner.indexOf('|');
    const name = (bar < 0 ? inner : inner.slice(0, bar)).trim();
    const fallback = bar < 0 ? null : inner.slice(bar + 1).trim();
    if (!name || /[{}]/.test(name)) return { ok: false, problem: { reason: 'unbalanced_braces' } };
    const unknown = knownVar(name);
    if (unknown) return { ok: false, problem: unknown };
    if (
      fallback !== null &&
      (!fallback || [...fallback].length > MAX_FALLBACK_CHARS || /[{}]/.test(fallback) || /\p{Cc}/u.test(fallback))
    ) {
      return { ok: false, problem: { reason: 'fallback_invalid' } };
    }
    segments.push({ kind: 'var', name, fallback });
    rest = after.slice(end + 2);
  }
}

/** The variables a parsed template uses, each once, in order. */
export function varsOf(segments: Segment[]): string[] {
  const out: string[] = [];
  for (const s of segments) if (s.kind === 'var' && !out.includes(s.name)) out.push(s.name);
  return out;
}

/** The text with each variable's value, its fallback, or `[name]` when neither is there. */
export function renderSegments(segments: Segment[], values: Record<string, string>): string {
  return segments
    .map((s) => (s.kind === 'text' ? s.text : values[s.name]?.trim() ? values[s.name] : (s.fallback ?? `[${s.name}]`)))
    .join('');
}

/** The links of a body: `http(s)://` up to whitespace, trailing punctuation trimmed. */
export function linksOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/\S+/g)) {
    const link = m[0].replace(/[.,;:!?)\]'"]+$/, '');
    if (!out.includes(link)) out.push(link);
  }
  return out;
}

/** The footer Jeeta appends to every outreach email (`jt_outreach::Footer::render`). */
export function footerText(
  lang: TemplateLang,
  basis: 'public_business_data' | 'consent',
  identity: { sender_company: string; sender_address: string; privacy_notice_url: string },
  unsubscribeUrl: string,
): string {
  const lines =
    lang === 'tr'
      ? {
          source:
            basis === 'public_business_data'
              ? 'Bu e-postayı işletmenizin herkese açık iletişim bilgileri üzerinden gönderiyoruz.'
              : 'Bu e-postayı bizden ileti almayı kabul ettiğiniz için alıyorsunuz.',
          privacy: 'Kişisel verilerin işlenmesi hakkında:',
          unsubscribe: 'Bu e-postaları almak istemiyorsanız:',
        }
      : {
          source:
            basis === 'public_business_data'
              ? "We are sending this email to your business's publicly listed contact details."
              : 'You are receiving this email because you agreed to receive messages from us.',
          privacy: 'About the processing of personal data:',
          unsubscribe: 'To stop receiving these emails:',
        };
  return [
    '--',
    `${identity.sender_company.trim()} · ${identity.sender_address.trim()}`,
    lines.source,
    `${lines.privacy} ${identity.privacy_notice_url.trim()}`,
    `${lines.unsubscribe} ${unsubscribeUrl}`,
  ].join('\n');
}
