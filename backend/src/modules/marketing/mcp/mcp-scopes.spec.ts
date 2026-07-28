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
