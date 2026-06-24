import { BadRequestException } from '@nestjs/common';

/** The three Meta messaging channel types (WhatsApp Cloud + Messenger + IG DM). */
const META_CHANNEL_TYPES = new Set(['WHATSAPP', 'MESSENGER', 'INSTAGRAM']);

export function isMetaChannelType(type: string): boolean {
  return META_CHANNEL_TYPES.has(type);
}

/**
 * Validate a Meta messaging channel's secrets at save-time (the assertNetgsmSmsSecrets
 * analog) — fail with an actionable message instead of an opaque Graph error on
 * the first send. WHATSAPP needs accessToken + phoneNumberId; MESSENGER/INSTAGRAM
 * need a pageAccessToken.
 */
export function assertMetaSecrets(type: string, secrets: Record<string, string> | undefined): void {
  const s = secrets ?? {};
  const present = (k: string) => typeof s[k] === 'string' && s[k].trim() !== '';

  if (type === 'WHATSAPP') {
    if (!present('accessToken')) {
      throw new BadRequestException(
        'WhatsApp channel requires an "accessToken" (a WhatsApp Cloud API system-user or page token).',
      );
    }
    if (!present('phoneNumberId')) {
      throw new BadRequestException(
        'WhatsApp channel requires a "phoneNumberId" (the Cloud API phone number id, also the channel externalId).',
      );
    }
    return;
  }
  if (type === 'MESSENGER' || type === 'INSTAGRAM') {
    if (!present('pageAccessToken')) {
      throw new BadRequestException(
        `${type} channel requires a "pageAccessToken" (the Page access token the Graph Send API uses).`,
      );
    }
    return;
  }
  // Non-Meta types are validated elsewhere (or not at all).
}
