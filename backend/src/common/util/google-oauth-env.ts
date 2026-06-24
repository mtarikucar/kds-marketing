/**
 * Google OAuth client credentials, read from EITHER historical env name.
 *
 * The codebase grew two names for the same Google OAuth app: Calendar used
 * GOOGLE_OAUTH_CLIENT_ID/_SECRET while review-sync + Google Business Profile used
 * GOOGLE_CLIENT_ID/_SECRET. An operator who set one pair silently failed to
 * enable the other feature. These accessors accept both (OAUTH-prefixed first),
 * so configuring Google once enables every Google feature.
 */
export function googleOAuthClientId(): string | undefined {
  return (process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID)?.trim() || undefined;
}

export function googleOAuthClientSecret(): string | undefined {
  return (process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET)?.trim() || undefined;
}

export function isGoogleOAuthConfigured(): boolean {
  return !!(googleOAuthClientId() && googleOAuthClientSecret());
}
