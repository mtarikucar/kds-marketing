import { expandScopes, MCP_READ_SCOPES, MCP_WRITE_SCOPES } from './mcp-scopes';

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
});
