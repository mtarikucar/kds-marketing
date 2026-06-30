import { BadRequestException } from '@nestjs/common';

/**
 * Validate the secret credentials of a TikTok DM channel at save-time. The
 * TikTok Business Messaging API requires an `accessToken` (the OAuth access
 * token with messaging scope). Failing here with an actionable message beats
 * discovering it as an opaque API error on the first send.
 */
export function assertTiktokDmSecrets(secrets: Record<string, string> | undefined): void {
  const s = secrets ?? {};
  const present = (k: string) => typeof s[k] === 'string' && s[k].trim() !== '';

  if (!present('accessToken')) {
    throw new BadRequestException(
      'TikTok DM channel requires an "accessToken" (TikTok-for-Business messaging token).',
    );
  }
}
