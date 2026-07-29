/**
 * The granular permission vocabulary the MCP tool surface uses. These strings
 * are the ones already defined in `marketing/roles/permissions.ts` — MCP does
 * NOT introduce a parallel vocabulary.
 */
export const MCP_READ_SCOPES = [
  'leads.read',
  'contacts.read',
  'campaigns.read',
  'reports.read',
  'tasks.read',
] as const;

export const MCP_WRITE_SCOPES = [
  'leads.write',
  'tasks.write',
] as const;

/**
 * The COMPLETE granular vocabulary an MCP caller can hold — the union of the
 * two legacy-expansion sets above plus the scopes only a granular grant can
 * carry (`campaigns.write`/`campaigns.send`/`contacts.write`/`settings.manage`
 * are deliberately outside the legacy `write` expansion; see the note below).
 *
 * This is what the OAuth authorization server publishes as `scopes_supported`
 * (RFC 9728 / RFC 8414) and what a consent screen offers. Extending this list
 * is how a new tool's scope becomes requestable — `mcp-oauth`'s metadata spec
 * fails if a tool ever declares a scope that is missing here, since such a
 * tool would be unreachable over OAuth.
 *
 * Every entry is a real permission from `marketing/roles/permissions.ts`; MCP
 * introduces no vocabulary of its own.
 */
export const MCP_ALL_SCOPES = [
  'leads.read',
  'leads.write',
  'contacts.read',
  'contacts.write',
  'campaigns.read',
  'campaigns.write',
  'campaigns.send',
  'reports.read',
  'tasks.read',
  'tasks.write',
  'settings.manage',
] as const;

/**
 * API keys minted before the MCP surface existed carry only the coarse
 * `read`/`write` scopes (see ApiKeysService). Expand those into the granular
 * vocabulary so existing keys keep working, and pass granular scopes through
 * untouched.
 *
 * `contacts.write` and `campaigns.send` are deliberately EXCLUDED from the
 * legacy `write` expansion: over the REST API a coarse `write` key can only
 * touch leads/tags/segments, but those two scopes authorise
 * `jeeta.send_message`, `jeeta.publish_social_post` and
 * `jeeta.set_campaign_status` — reaching real customers and audiences. The
 * design spec (§5.3) promises `write -> *:write`, not `*:send`, so a key must
 * carry those scopes explicitly/granularly to use the tools that need them.
 */
export function expandScopes(raw: string[]): string[] {
  const out = new Set<string>();
  for (const scope of raw) {
    if (scope === 'read') {
      MCP_READ_SCOPES.forEach((s) => out.add(s));
    } else if (scope === 'write') {
      MCP_READ_SCOPES.forEach((s) => out.add(s));
      MCP_WRITE_SCOPES.forEach((s) => out.add(s));
    } else {
      out.add(scope);
    }
  }
  return [...out];
}
