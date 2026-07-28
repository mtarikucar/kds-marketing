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
  'contacts.write',
  'tasks.write',
  'campaigns.send',
] as const;

/**
 * API keys minted before the MCP surface existed carry only the coarse
 * `read`/`write` scopes (see ApiKeysService). Expand those into the granular
 * vocabulary so existing keys keep working, and pass granular scopes through
 * untouched.
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
