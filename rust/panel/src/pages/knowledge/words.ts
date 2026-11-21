import type { TFunction } from 'i18next';
import { isApiError } from '@/api/client';
import type { AutoReplyView, Cap, RulesOut } from '@/api/knowledge';
import { errorMessage } from '@/lib/errors';
import { minorDigits } from '@/lib/format';

// The Bilgi bankası page's sentences that are built from facts (design 2026-11-19 §4.11).

/** An amount as the owner reads it in a rule: "₺5.000", with kuruş only when there are some. */
export function capMoney(minor: number, currency: string, language: string): string {
  const digits = minorDigits(currency);
  const value = minor / 10 ** digits;
  const locale = language.startsWith('tr') ? 'tr-TR' : 'en-GB';
  const whole = Number.isInteger(value);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: whole ? 0 : digits,
      maximumFractionDigits: whole ? 0 : digits,
    }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

/** "Reklama ayda en çok ₺5.000." / "Reklama haftada en çok …" / "Reklam yok." */
export function adLine(t: TFunction, cap: Cap | null, language: string): string {
  if (!cap || cap.amount_minor <= 0) return t('knowledge.rules.adNone');
  const amount = capMoney(cap.amount_minor, cap.currency, language);
  return cap.period === 'weekly' ? t('knowledge.rules.adWeekly', { amount }) : t('knowledge.rules.adMonthly', { amount });
}

/** "Ücretli mesajlara ayda en çok ₺0."; `null` while no limit is set (the line is not shown). */
export function messageLine(t: TFunction, cap: Cap | null, language: string): string | null {
  if (!cap) return null;
  const amount = capMoney(cap.amount_minor, cap.currency, language);
  return cap.period === 'weekly' ? t('knowledge.rules.messageWeekly', { amount }) : t('knowledge.rules.messageMonthly', { amount });
}

/**
 * The automatic replies' line: "Mesajlara otomatik yanıt: WhatsApp · ₺2.750–₺10.000", what keeps
 * them waiting, or `null` while they are off (the line is not shown).
 */
export function autoReplyLine(t: TFunction, auto: AutoReplyView, language: string): string | null {
  if (auto.capability_ids.length === 0) return null;
  if (auto.off_reason === 'no_key') return t('knowledge.rules.autoReplyNoKey');
  if (auto.off_reason === 'standard_missing' || !auto.price) return t('knowledge.rules.autoReplyWaiting');
  const { min_minor, max_minor, currency } = auto.price;
  return t('knowledge.rules.autoReplyOn', {
    channels: 'WhatsApp',
    min: capMoney(min_minor, currency, language),
    max: capMoney(max_minor, currency, language),
  });
}

/** "E-posta bildirimi: …": while the automatic replies and their email notices are on. */
export function notifyLine(t: TFunction, auto: AutoReplyView): string | null {
  if (auto.capability_ids.length === 0 || !auto.notify.available || !auto.notify.on || !auto.notify.from) return null;
  return t('knowledge.rules.notifyOn', { from: auto.notify.from });
}

/**
 * The approval line, built from the effective gates (§4.6.3): the switch, else the accounts of the
 * list, then TikTok's own screen when a TikTok account is connected.
 */
export function approvalLine(t: TFunction, rules: Pick<RulesOut, 'post_approval' | 'post_approval_accounts' | 'tiktok_connected'>): string {
  const names = listedNames(rules.post_approval_accounts);
  const base = rules.post_approval
    ? t('knowledge.rules.approvalAll')
    : names.length === 0
      ? t('knowledge.rules.approvalNone')
      : t('knowledge.rules.approvalExcept', { accounts: names.join(', ') });
  return rules.tiktok_connected ? `${base} ${t('knowledge.rules.tiktok')}` : base;
}

/**
 * The names of the listed accounts that are still in the workspace: the read names an account it
 * no longer has with an empty name, and nothing posts there any more.
 */
export function listedNames(accounts: RulesOut['post_approval_accounts']): string[] {
  return accounts.map((a) => a.name.trim()).filter(Boolean);
}

/** The knowledge base's own refusals in the owner's words; anything else as the panel says it. */
export function knowledgeError(t: TFunction, err: unknown): string {
  if (isApiError(err)) {
    switch (err.details.reason) {
      case 'card_changed':
      case 'rules_changed':
      case 'goals_changed':
      case 'note_changed':
        return t('knowledge.conflict');
      case 'card_archived':
        return t('knowledge.cards.archived');
      case 'too_many_cards':
        return t('knowledge.cards.tooMany');
      case 'proposal_superseded':
      case 'proposal_closed':
        return t('knowledge.proposals.superseded');
      case 'proposal_expired':
        return t('knowledge.proposals.expired');
      case 'note_closed':
      case 'note_withdrawn':
        return t('knowledge.notes.closed');
      case 'post_approval_all':
        return t('knowledge.rules.dialog.approvalAll');
      default:
        break;
    }
  }
  return errorMessage(t, err);
}
