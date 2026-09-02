/**
 * Google OAuth client credentials, read from EITHER historical env name.
 *
 * The codebase grew two names for the same Google OAuth app: Calendar used
 * GOOGLE_OAUTH_CLIENT_ID/_SECRET while review-sync + Google Business Profile used
 * GOOGLE_CLIENT_ID/_SECRET. An operator who set one pair silently failed to
 * enable the other feature. These accessors accept both (OAUTH-prefixed first),
 * so configuring Google once enables every Google feature.
 *
 * The NAMES are exported too, and are the single source of truth for them: the
 * social-planner's per-network env table declares Google's credentials with
 * these lists rather than restating one spelling, and the operator-facing
 * "not configured" messages enumerate them. A second hand-written copy is how
 * the table came to disagree with the resolver in the first place.
 */
export const GOOGLE_CLIENT_ID_ENVS = ['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_CLIENT_ID'] as const;
export const GOOGLE_CLIENT_SECRET_ENVS = [
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_CLIENT_SECRET',
] as const;

/**
 * First env var in `names` that holds a non-blank value, trimmed.
 *
 * Blank counts as UNSET on purpose, and the search continues past it: an env
 * var exported as an empty (or whitespace) string is a half-finished
 * configuration, and treating it as a credential turns a clear "not configured"
 * into an opaque rejection from the provider.
 */
export function firstEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function googleOAuthClientId(): string | undefined {
  return firstEnv(GOOGLE_CLIENT_ID_ENVS);
}

export function googleOAuthClientSecret(): string | undefined {
  return firstEnv(GOOGLE_CLIENT_SECRET_ENVS);
}

export function isGoogleOAuthConfigured(): boolean {
  return !!(googleOAuthClientId() && googleOAuthClientSecret());
}
