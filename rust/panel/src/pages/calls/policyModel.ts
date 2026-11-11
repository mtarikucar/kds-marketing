import type { CallPolicy } from '@/api/calls';

export const SECTIONS = ['opening', 'notices', 'waiting', 'silence', 'ending', 'limits'] as const;
export type Section = (typeof SECTIONS)[number];
export const NUMBERS = [
  'max_duration_s',
  'slow_agent_s',
  'holding_again_s',
  'fallback_after_s',
  'caller_silence_s',
  'caller_silence_close_s',
  'estimated_minor_per_minute',
] as const;
export type NumberKey = (typeof NUMBERS)[number];
export type TextKey =
  | 'greeting_inbound'
  | 'opening_outbound'
  | 'transcript_notice'
  | 'disclosure_sentence'
  | 'recording_announcement'
  | 'closing'
  | 'voicemail_text';
export type PhraseKey = 'holding_default' | keyof CallPolicy['phrases'];
export const PHRASES: PhraseKey[] = [
  'holding_default',
  'acknowledgements',
  'fillers',
  'long_wait',
  'not_heard',
  'still_there',
  'fault',
];
export const TEXTS: TextKey[] = [
  'greeting_inbound',
  'opening_outbound',
  'transcript_notice',
  'disclosure_sentence',
  'recording_announcement',
  'closing',
  'voicemail_text',
];
export const FIELD_SECTION: Record<
  NumberKey | TextKey | PhraseKey | 'handoff_extension' | 'disclose_assistant',
  Section
> = {
  greeting_inbound: 'opening',
  opening_outbound: 'opening',
  transcript_notice: 'notices',
  disclosure_sentence: 'notices',
  recording_announcement: 'notices',
  disclose_assistant: 'notices',
  slow_agent_s: 'waiting',
  holding_again_s: 'waiting',
  fallback_after_s: 'waiting',
  holding_default: 'waiting',
  acknowledgements: 'waiting',
  fillers: 'waiting',
  long_wait: 'waiting',
  caller_silence_s: 'silence',
  caller_silence_close_s: 'silence',
  not_heard: 'silence',
  still_there: 'silence',
  closing: 'ending',
  voicemail_text: 'ending',
  fault: 'ending',
  max_duration_s: 'limits',
  estimated_minor_per_minute: 'limits',
  handoff_extension: 'limits',
};
export const numberTexts = (p: CallPolicy) =>
  Object.fromEntries(NUMBERS.map((k) => [k, String(p[k])])) as Record<NumberKey, string>;
export const phraseList = (p: CallPolicy, k: PhraseKey): string[] =>
  k === 'holding_default' ? p.holding_default : p.phrases[k];
export function payload(p: CallPolicy, n: Record<NumberKey, string>): CallPolicy {
  const result = { ...p, phrases: { ...p.phrases }, handoff_extension: p.handoff_extension?.trim() || null };
  for (const k of NUMBERS) result[k] = Number(n[k]);
  for (const k of PHRASES) {
    const list = phraseList(p, k)
      .map((s) => s.trim())
      .filter(Boolean);
    if (k === 'holding_default') result.holding_default = list;
    else result.phrases[k] = list;
  }
  return result;
}
export type PolicyIssue = { section: Section; key: string };
/** Mirrors the domain bounds; no blank-to-zero coercion while editing. */
export function validate(p: CallPolicy, n: Record<NumberKey, string>): PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  for (const k of NUMBERS) {
    const v = Number(n[k]);
    if (!n[k].trim() || !Number.isSafeInteger(v) || v < (k === 'estimated_minor_per_minute' ? 0 : 1))
      issues.push({ section: FIELD_SECTION[k], key: 'wholeNumber' });
  }
  if (Number(n.max_duration_s) > 900) issues.push({ section: 'limits', key: 'durationRange' });
  if (
    !(
      Number(n.slow_agent_s) < Number(n.holding_again_s) &&
      Number(n.holding_again_s) < Number(n.fallback_after_s) &&
      Number(n.fallback_after_s) <= 60
    )
  )
    issues.push({ section: 'waiting', key: 'waitingOrder' });
  if (
    !(
      Number(n.caller_silence_s) < Number(n.caller_silence_close_s) && Number(n.caller_silence_close_s) <= 120
    )
  )
    issues.push({ section: 'silence', key: 'silenceOrder' });
  if (p.handoff_extension?.trim() && !/^\d{1,16}$/.test(p.handoff_extension.trim()))
    issues.push({ section: 'limits', key: 'extensionFormat' });
  for (const k of TEXTS) {
    const text = p[k];
    if (text && (!text.trim() || [...text].length > 600))
      issues.push({ section: FIELD_SECTION[k], key: 'textLength' });
  }
  for (const k of PHRASES) {
    const list = phraseList(p, k).filter((s) => s.trim());
    if (list.length > 5 || list.some((s) => [...s.trim()].length > 600))
      issues.push({ section: FIELD_SECTION[k], key: 'phraseLimit' });
  }
  return issues.filter(
    (issue, i) => issues.findIndex((x) => x.section === issue.section && x.key === issue.key) === i,
  );
}
