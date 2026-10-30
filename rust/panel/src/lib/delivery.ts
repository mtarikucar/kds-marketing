import type { TFunction } from 'i18next';
import type { InboxMessage } from '@/api/types';

/** Providers a failure line names (`jt_connector::Provider::key`). */
const PROVIDERS = ['meta', 'netgsm', 'x', 'mail', 'tiktok', 'linkedin'];

/** Provider error codes (Meta Graph `(#code)`) explained in the owner's words. */
const CODES = {
  '131030': 'recipientNotAllowed',
  '131047': 'windowClosed',
  '190': 'reconnect',
} as const;

/** Error kinds (`jt_connector::ConnectorError::kind`) and stable reasons explained the same way. */
const KINDS = {
  auth: 'reconnect',
  permission: 'permission',
  throttle: 'throttled',
  send_configuration_invalid: 'configuration',
} as const;

/** The TikTok cases explained in the owner's words (`failure.*`). */
type TiktokCase =
  | 'tiktokUnaudited'
  | 'tiktokPrivacy'
  | 'tiktokCap'
  | 'tiktokAppCap'
  | 'tiktokBanned'
  | 'tiktokDomain'
  | 'tiktokSpam'
  | 'tiktokMedia';

/** TikTok's error codes (its answers' `error.code`, a post's `fail_reason`) explained, first match wins. */
const TIKTOK_CODES: [RegExp, TiktokCase][] = [
  [/unaudited_client_can_only_post_to_private_accounts/, 'tiktokUnaudited'],
  [/privacy_level_option_mismatch|privacy level \S+ not available/, 'tiktokPrivacy'],
  [/spam_risk_too_many_posts|spam_risk_too_many_pending_share/, 'tiktokCap'],
  [/reached_active_user_cap/, 'tiktokAppCap'],
  [/spam_risk_user_banned_from_posting/, 'tiktokBanned'],
  [/url_ownership_unverified/, 'tiktokDomain'],
  [/spam_risk_text|spam_risk\b/, 'tiktokSpam'],
  [/(file_format|duration|frame_rate|picture_size)_check_failed/, 'tiktokMedia'],
];

/** What TikTok says, by its own code. */
function tiktokCase(text: string): TiktokCase | null {
  return TIKTOK_CODES.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

/** What X says by HTTP status, and how to tell it from a generic refusal. */
function xCase(text: string): 'xCredits' | 'xDuplicate' | null {
  const status = /HTTP (\d{3})/.exec(text)?.[1];
  if (status === '402' || /credits/i.test(text)) return 'xCredits';
  if (status === '403' && /duplicate/i.test(text)) return 'xDuplicate';
  return null;
}

/**
 * Why a send or a publication failed, for the owner, from the recorded failure line
 * (`kind: provider: reason`, `jt_app::usecases::failure`): a known provider case or error kind in
 * plain words, else the provider's own text.
 */
export function failureText(t: TFunction, reason: string): string {
  const parts = reason.split(': ');
  const kind = parts[0];
  const provider = parts.length > 1 && PROVIDERS.includes(parts[1]) ? parts[1] : null;
  const text = parts.slice(provider ? 2 : 1).join(': ');
  const code = /\(#(\d+)/.exec(text)?.[1];
  if (code && code in CODES) return t(`failure.${CODES[code as keyof typeof CODES]}`);
  const x = provider === 'x' ? xCase(text) : null;
  if (x) return t(`failure.${x}`);
  const tiktok = provider === 'tiktok' ? tiktokCase(text) : null;
  if (tiktok) return t(`failure.${tiktok}`);
  if (kind in KINDS) return t(`failure.${KINDS[kind as keyof typeof KINDS]}`);
  return text || reason;
}

/** The delivery line under a message: its state, with the reason a send failed when one is known. */
export function deliveryText(t: TFunction, message: Pick<InboxMessage, 'status' | 'failure_reason'>): string {
  const { status, failure_reason: reason } = message;
  if (typeof status !== 'string') return t('inbox.delivery.refused', { reason: status.refused.reason });
  if (reason && status === 'failed') return t('inbox.delivery.failedBecause', { reason: failureText(t, reason) });
  if (reason && status === 'unknown') return t('inbox.delivery.unknownBecause', { reason: failureText(t, reason) });
  return t(`inbox.delivery.${status}`);
}
