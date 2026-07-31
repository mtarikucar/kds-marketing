import { expandScopes, MCP_ALL_SCOPES, MCP_READ_SCOPES, MCP_WRITE_SCOPES } from './mcp-scopes';

describe('expandScopes', () => {
  it('expands legacy "read" into every read scope', () => {
    const out = expandScopes(['read']);
    for (const s of MCP_READ_SCOPES) expect(out).toContain(s);
    expect(out).not.toContain('leads.write');
  });

  it('expands legacy "write" into read + write scopes', () => {
    const out = expandScopes(['write']);
    expect(out).toContain('leads.write');
    expect(out).toContain('leads.read');
  });

  it('does not grant send/publish authority from legacy "write"', () => {
    const out = expandScopes(['write']);
    expect(out).not.toContain('campaigns.send');
    expect(out).not.toContain('contacts.write');
  });

  it('does not grant campaigns.write from legacy "write" either — new granular scopes stay opt-in, never acquired by default', () => {
    const out = expandScopes(['write']);
    expect(out).not.toContain('campaigns.write');
  });

  it('does not grant manager-tier leads.manage from legacy "read"/"write" — reassigning another rep\'s leads stays opt-in', () => {
    expect(expandScopes(['read'])).not.toContain('leads.manage');
    expect(expandScopes(['write'])).not.toContain('leads.manage');
  });

  it('passes an explicitly granular leads.manage through untouched', () => {
    expect(expandScopes(['leads.manage'])).toEqual(['leads.manage']);
  });

  it('does not grant settings.manage from legacy "read" or "write"', () => {
    expect(expandScopes(['read'])).not.toContain('settings.manage');
    expect(expandScopes(['write'])).not.toContain('settings.manage');
  });

  it('passes an explicitly granular campaigns.write through untouched', () => {
    expect(expandScopes(['campaigns.write'])).toEqual(['campaigns.write']);
  });

  it('passes an explicitly granular settings.manage through untouched', () => {
    expect(expandScopes(['settings.manage'])).toEqual(['settings.manage']);
  });

  it('passes an explicitly granular campaigns.send through untouched', () => {
    expect(expandScopes(['campaigns.send'])).toEqual(['campaigns.send']);
  });

  it('passes granular scopes through untouched', () => {
    expect(expandScopes(['reports.read'])).toEqual(['reports.read']);
  });

  it('de-duplicates when legacy and granular overlap', () => {
    const out = expandScopes(['read', 'reports.read']);
    expect(out.filter((s) => s === 'reports.read')).toHaveLength(1);
  });

  it('returns an empty array for no input', () => {
    expect(expandScopes([])).toEqual([]);
  });

  /**
   * Faz 5 D5 — the courses/memberships lane. `courses.manage` is a real
   * permission from `roles/permissions.ts` (OWNER/MANAGER only), and like
   * `leads.manage` and `automations.manage` before it, it must never be
   * acquired by a legacy coarse key: enrolling someone into a paid course, or
   * reading the whole course catalogue, was never within a `write` key's
   * authority over REST.
   */
  it('does not grant manager-tier courses.manage from legacy "read"/"write"', () => {
    expect(expandScopes(['read'])).not.toContain('courses.manage');
    expect(expandScopes(['write'])).not.toContain('courses.manage');
  });

  it('passes an explicitly granular courses.manage through untouched', () => {
    expect(expandScopes(['courses.manage'])).toEqual(['courses.manage']);
  });

  it('publishes courses.manage in the OAuth-requestable vocabulary', () => {
    // MCP_ALL_SCOPES is what `scopes_supported` advertises and what a consent
    // screen offers. A tool scope missing from it is a tool unreachable over
    // OAuth — see mcp-oauth-metadata.controller.spec.ts.
    expect(MCP_ALL_SCOPES).toContain('courses.manage');
  });
});
