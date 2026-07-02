/**
 * Single source of truth for channel-type field metadata, shared by the Channels
 * settings page and the Account Center's inline manual-connect dialog — so the
 * per-type secret fields / external-id labels can't drift between the two places.
 */

export const CHANNEL_TYPES = [
  'WEBCHAT',
  'WHATSAPP',
  'SMS',
  'INSTAGRAM',
  'MESSENGER',
  'TIKTOK',
  'LINKEDIN',
  'EMAIL',
  'VOICE',
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

/** Sealed credential keys collected per type (posted under `secrets`). */
export const SECRET_FIELDS: Record<ChannelType, string[]> = {
  WEBCHAT: [],
  WHATSAPP: ['accessToken', 'phoneNumberId'],
  SMS: ['usercode', 'password', 'msgheader'],
  INSTAGRAM: ['pageAccessToken'],
  MESSENGER: ['pageAccessToken'],
  TIKTOK: ['accessToken'],
  LINKEDIN: ['accessToken'],
  EMAIL: ['smtpHost', 'smtpPort', 'smtpUser', 'smtpPass', 'fromEmail'],
  VOICE: ['accountSid', 'authToken'],
};

/** Types that also need a provider-side `externalId`, with its field label. */
export const NEEDS_EXTERNAL_ID: Record<string, string> = {
  WHATSAPP: 'Phone number ID',
  INSTAGRAM: 'Page ID',
  MESSENGER: 'Page ID',
  TIKTOK: 'TikTok business/creator ID',
  LINKEDIN: 'Actor URN (urn:li:organization:… or urn:li:person:…)',
  EMAIL: 'Inbound email address',
  VOICE: 'Twilio phone number (E.164)',
};

/** Human labels for the secret field keys (fallback = the key itself). */
export const SECRET_LABELS: Record<string, string> = {
  usercode: 'NetGSM usercode',
  password: 'NetGSM password',
  msgheader: 'Sender header (msgheader)',
  smtpHost: 'SMTP host',
  smtpPort: 'SMTP port',
  smtpUser: 'SMTP username',
  smtpPass: 'SMTP password',
  fromEmail: 'From email',
  accountSid: 'Twilio Account SID',
  authToken: 'Twilio Auth token',
  accessToken: 'Access token',
  phoneNumberId: 'Phone number ID',
  pageAccessToken: 'Page access token',
};

/** Secret keys rendered as password inputs. */
export const SECRET_MASKED = new Set(['password', 'smtpPass', 'authToken', 'accessToken', 'pageAccessToken']);

/** The manual (non-OAuth) channel types the Account Center can set up inline. */
export const MANUAL_CHANNEL_TYPES: ChannelType[] = ['SMS', 'EMAIL', 'WEBCHAT', 'VOICE'];
