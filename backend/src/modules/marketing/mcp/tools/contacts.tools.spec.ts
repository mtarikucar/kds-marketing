import { MCP_NON_REP_PRINCIPAL } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';
import { registerContactsTools } from './contacts.tools';

const SENTINEL = { id: 'sys-1', workspaceId: 'ws-a', role: 'SYSTEM' };

function setup() {
  const registry = new McpToolRegistry();
  const leads = {
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    create: jest.fn().mockResolvedValue({ id: 'l1' }),
  };
  const companies = {
    list: jest.fn().mockResolvedValue([]),
    listContacts: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'c1' }),
  };
  const principals = {
    resolve: jest.fn().mockResolvedValue(SENTINEL),
    assertActiveMember: jest.fn().mockResolvedValue({ id: 'u2', role: 'REP' }),
  };
  registerContactsTools(registry, { leads, companies, principals } as never);
  return { registry, leads, companies, principals };
}

const KEY_CTX = { workspaceId: 'ws-a', grantedScopes: [] };

describe('contacts & companies MCP tools — registration metadata', () => {
  /**
   * A "contact" in this product IS a Lead row — there is no separate Contact
   * table. So the contact tools demand BOTH the contacts scope (the surface
   * they present) and the leads scope (the rows they actually touch): scopes
   * are all-required, so this is strictly narrower than either alone and no
   * caller gains reach over lead rows it did not already have.
   */
  it.each([
    ['jeeta.search_contacts', ['contacts.read', 'leads.read'], 'READ'],
    ['jeeta.create_contact', ['contacts.write', 'leads.write'], 'WRITE'],
    ['jeeta.search_companies', ['contacts.read'], 'READ'],
    ['jeeta.create_company', ['contacts.write'], 'WRITE'],
  ])('registers %s with scopes %p as %s and no approval gate', (name, scopes, risk) => {
    const { registry } = setup();
    const tool = registry.get(name)!;
    expect(tool).toBeDefined();
    expect(tool.scopes).toEqual(scopes);
    expect(tool.risk).toBe(risk);
    expect(tool.requiresApproval).toBe(false);
    expect(tool.inputSchema).toBeDefined();
  });
});

describe('jeeta.search_contacts', () => {
  it('searches people through the leads service with the read-only visibility principal', async () => {
    const { registry, leads } = setup();
    await registry.get('jeeta.search_contacts')!.handler(KEY_CTX, { search: 'ali' });
    expect(leads.findAll).toHaveBeenCalledWith(
      'ws-a',
      expect.objectContaining({ search: 'ali' }),
      MCP_NON_REP_PRINCIPAL.userId,
      MCP_NON_REP_PRINCIPAL.role,
    );
  });

  it('answers "who works at this company?" through the company roster, scoped to the caller workspace', async () => {
    const { registry, companies, leads } = setup();
    await registry.get('jeeta.search_contacts')!.handler(KEY_CTX, { companyId: 'c1' });
    expect(companies.listContacts).toHaveBeenCalledWith('ws-a', 'c1');
    expect(leads.findAll).not.toHaveBeenCalled();
  });

  it('applies the real caller and role on an OAuth session so a REP sees only their own book', async () => {
    const { registry, leads } = setup();
    await registry
      .get('jeeta.search_contacts')!
      .handler({ workspaceId: 'ws-a', grantedScopes: [], userId: 'u9', userRole: 'REP' }, {});
    expect(leads.findAll).toHaveBeenCalledWith('ws-a', expect.anything(), 'u9', 'REP');
  });
});

describe('jeeta.create_contact', () => {
  it('creates the person through MarketingLeadsService, so dedup/auto-assign/custom fields still apply', async () => {
    const { registry, leads } = setup();
    await registry.get('jeeta.create_contact')!.handler(KEY_CTX, {
      companyId: 'c1',
      contactPerson: 'Ali',
      businessName: 'Acme',
      businessType: 'RESTAURANT',
      source: 'REFERRAL',
    });
    expect(leads.create).toHaveBeenCalledWith(
      'ws-a',
      expect.objectContaining({ companyId: 'c1', contactPerson: 'Ali' }),
      'sys-1',
      'SYSTEM',
    );
  });

  it('requires the company link — an unattached person is jeeta.create_lead', () => {
    const { registry } = setup();
    expect(() =>
      (registry.get('jeeta.create_contact')!.inputSchema as { parse: (v: unknown) => unknown }).parse({
        contactPerson: 'Ali',
        businessName: 'Acme',
        businessType: 'RESTAURANT',
        source: 'REFERRAL',
      }),
    ).toThrow();
  });

  it('never attributes the contact to the read-only placeholder principal', async () => {
    const { registry, leads } = setup();
    await registry.get('jeeta.create_contact')!.handler(KEY_CTX, {
      companyId: 'c1',
      contactPerson: 'Ali',
      businessName: 'Acme',
      businessType: 'RESTAURANT',
      source: 'REFERRAL',
    });
    expect(leads.create).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      MCP_NON_REP_PRINCIPAL.userId,
      expect.anything(),
    );
  });
});

describe('jeeta.search_companies / jeeta.create_company', () => {
  it('lists companies scoped to the caller workspace, excluding archived by default', async () => {
    const { registry, companies } = setup();
    await registry.get('jeeta.search_companies')!.handler(KEY_CTX, { search: 'acme' });
    expect(companies.list).toHaveBeenCalledWith('ws-a', { search: 'acme', includeArchived: undefined });
  });

  it('creates a company in the caller workspace', async () => {
    const { registry, companies } = setup();
    await registry.get('jeeta.create_company')!.handler(KEY_CTX, { name: 'Acme', city: 'İzmir' });
    expect(companies.create).toHaveBeenCalledWith('ws-a', expect.objectContaining({ name: 'Acme', city: 'İzmir' }));
  });
});
