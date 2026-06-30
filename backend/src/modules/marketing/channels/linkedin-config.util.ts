import { BadRequestException } from '@nestjs/common';

/**
 * Validate the secret credentials of a LinkedIn engagement channel at
 * save-time. Engagement (read/reply to comments on OWNED org posts) needs an
 * `accessToken` — the OAuth token carrying w_organization_social /
 * r_organization_social. Failing here with an actionable message beats
 * discovering it as an opaque /rest error on the first comment-reply.
 *
 * NOTE: a present token does NOT make the channel live. Engagement stays inert
 * behind the `configPublic.linkedinEngagement === 'granted'` capability flag
 * until LinkedIn Community Management access is approved.
 */
export function assertLinkedinEngagementSecrets(
  secrets: Record<string, string> | undefined,
): void {
  const s = secrets ?? {};
  const present = (k: string) => typeof s[k] === 'string' && s[k].trim() !== '';

  if (!present('accessToken')) {
    throw new BadRequestException(
      'LinkedIn engagement channel requires an "accessToken" (OAuth token with w_organization_social / r_organization_social).',
    );
  }
}
