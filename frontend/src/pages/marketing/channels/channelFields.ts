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

/**
 * Non-secret configPublic fields collected per type (posted under
 * `configPublic`, never `secrets` — these come back in the channel's public
 * view, unlike sealed credentials). NetGSM Phase 2 (İYS compliance): the
 * tenant's own İYS marka kodu (brand code — required for the auto-push
 * consent queue and to register the İYS push-back webhook) and their default
 * commercial/informational classification for the campaign composer.
 */
export const PUBLIC_FIELDS: Partial<Record<ChannelType, string[]>> = {
  // NetGSM Phase 6 Task 3 — `otpTransport` is the SmsOtpService delivery
  // preference (SMS default | WhatsApp, when the paid OTP-WhatsApp package
  // is active on the account). It lives on this SAME SMS channel row's
  // configPublic — no separate config surface.
  SMS: ['brandCode', 'iysDefault', 'otpTransport'],
};

/** Human labels for the configPublic field keys (fallback = the key itself). */
export const PUBLIC_LABELS: Record<string, string> = {
  brandCode: 'İYS Marka Kodu',
  iysDefault: 'Varsayılan İYS mesaj türü',
  otpTransport: 'OTP gönderim kanalı',
};

/** TR helper text shown under each configPublic field. */
export const PUBLIC_HELP: Record<string, string> = {
  brandCode:
    'İYS (İleti Yönetim Sistemi) panelinizden aldığınız marka kodu — ticari SMS onay/red senkronizasyonu ve webhook kaydı için gereklidir.',
  iysDefault: 'Bu kanaldan kampanya oluştururken varsayılan olarak seçili gelecek mesaj türü.',
  otpTransport:
    "Doğrulama kodları (2FA, telefon doğrulama) hangi kanaldan gönderilsin. WhatsApp seçeneği, NetGSM hesabınızda ücretli \"OTP WhatsApp\" paketi ve onaylı netgsm_verify_code şablonu gerektirir — paket yoksa veya gönderim başarısız olursa kod otomatik olarak SMS ile gönderilir.",
};

/** Fixed option lists for configPublic fields that are a choice, not free
 *  text — anything not listed here renders as a plain text Input. */
export const PUBLIC_SELECT_OPTIONS: Record<string, Array<{ value: string; label: string }>> = {
  iysDefault: [
    { value: 'BILGILENDIRME', label: 'Bilgilendirme (bilgilendirme amaçlı)' },
    { value: 'TICARI', label: 'Ticari (pazarlama/reklam)' },
  ],
  otpTransport: [
    { value: 'SMS', label: 'SMS (varsayılan)' },
    { value: 'WHATSAPP', label: "WhatsApp (ücretli OTP paketi gerekir, hata halinde SMS'e döner)" },
  ],
};
