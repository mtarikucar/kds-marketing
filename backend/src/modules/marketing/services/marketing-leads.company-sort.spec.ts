import { MarketingLeadsService } from './marketing-leads.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

/**
 * `sortBy=company` — the ORDER behind "Grupla: Şirkete göre" on the person
 * surface (2026-09-01 design, "Karar 2").
 *
 * Grouping a PAGE would have needed no backend at all: the surface could have
 * bucketed the 25 rows it already holds. It would also have lied. The list is
 * paginated and ordered by `lastActivityAt`, so a company's people are
 * scattered across pages — a header reading "Acme · 3" over a company with
 * forty contacts is worse than no grouping, and `/companies` (which shows the
 * true count) is exactly the page whose menu entry this grouping replaces.
 *
 * So the grouping is an ORDER, settled across the whole filtered set, and the
 * page is a window onto it — the way a grouped table has always worked. Every
 * member of a company is contiguous in that order; pagination cuts it, it does
 * not scramble it.
 *
 * It is resolved in memory for the same reason `lastActivityAt` is: the company
 * NAME lives in a table with no foreign key back to `leads` (soft `workspaceId`
 * scoping, see the Company model), so Postgres cannot order by it without a
 * second copy of this method's `where`.
 */
describe('MarketingLeadsService.findAll — sortBy=company', () => {
  const WS = 'ws-1';
  let prisma: MockPrismaClient;
  let svc: MarketingLeadsService;

  const lead = (id: string, companyId: string | null, createdAt: string) => ({
    id,
    companyId,
    createdAt: new Date(createdAt),
    businessName: id,
  });

  /**
   * The service reads the candidate set (id/createdAt/companyId) and then the
   * page rows; both come off `lead.findMany`, so the mock answers by what the
   * call asked for rather than by call index — an implementation that reorders
   * its reads must not silently pass.
   */
  const seed = (rows: ReturnType<typeof lead>[]) => {
    (prisma.lead.findMany as jest.Mock).mockImplementation((args: any) => {
      const ids: string[] | undefined = args?.where?.id?.in;
      if (ids) return Promise.resolve(rows.filter((r) => ids.includes(r.id)));
      return Promise.resolve(rows.map((r) => ({ id: r.id, createdAt: r.createdAt, companyId: r.companyId })));
    });
  };

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new MarketingLeadsService(
      prisma as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
    // Every enrichment statement is a raw query; none of them is what this
    // suite is about, and an unmocked one returns undefined and throws.
    (prisma.$queryRaw as unknown as jest.Mock).mockResolvedValue([]);
    prisma.lead.count.mockResolvedValue(0 as any);
    // The ids sort the OPPOSITE way from the names on purpose: `c-1` < `c-2`
    // while "Acme AŞ" < "Zeta Ltd". An implementation that groups by companyId
    // rather than by the name gets a different answer to every case below.
    (prisma.company.findMany as jest.Mock).mockResolvedValue([
      { id: 'c-1', name: 'Zeta Ltd' },
      { id: 'c-2', name: 'Acme AŞ' },
    ] as any);
  });

  it('orders the people by their company NAME, not by companyId', async () => {
    // Seeded in id order, which is the order a companyId-keyed grouping would
    // produce — and the opposite of the answer below. See the fixture above.
    seed([
      lead('l-zeta-1', 'c-1', '2026-01-05'),
      lead('l-acme-1', 'c-2', '2026-01-04'),
    ]);

    const res = await svc.findAll(WS, { sortBy: 'company' } as any, 'u1', 'OWNER');

    expect(res.data.map((r: any) => r.id)).toEqual(['l-acme-1', 'l-zeta-1']);
  });

  it('keeps a company’s people contiguous and newest-first inside the group', async () => {
    seed([
      lead('l-zeta-old', 'c-1', '2026-01-01'),
      lead('l-acme-old', 'c-2', '2026-01-02'),
      lead('l-zeta-new', 'c-1', '2026-03-01'),
      lead('l-acme-new', 'c-2', '2026-02-01'),
    ]);

    const res = await svc.findAll(WS, { sortBy: 'company' } as any, 'u1', 'OWNER');

    // Groups in name order; inside a group the owner's own sort survives.
    expect(res.data.map((r: any) => r.id)).toEqual([
      'l-acme-new', 'l-acme-old', 'l-zeta-new', 'l-zeta-old',
    ]);
  });

  /**
   * The whole reason this line of work exists. A person with no company must
   * still be REACHABLE — they form a real trailing block, they are counted in
   * `meta.total`, and no filter silently drops them.
   */
  it('puts the people with no company LAST, and never drops them', async () => {
    seed([
      lead('l-none-1', null, '2026-01-09'),
      lead('l-zeta-1', 'c-1', '2026-01-05'),
      lead('l-none-2', null, '2026-01-08'),
      lead('l-acme-1', 'c-2', '2026-01-04'),
    ]);

    const res = await svc.findAll(WS, { sortBy: 'company' } as any, 'u1', 'OWNER');

    expect(res.data.map((r: any) => r.id)).toEqual([
      'l-acme-1', 'l-zeta-1', 'l-none-1', 'l-none-2',
    ]);
    expect(res.meta.total).toBe(4);
  });

  /**
   * A `companyId` the workspace's own companies cannot name is UNGROUPED, not
   * a group headed by a raw uuid. It happens two ways: a company deleted by a
   * racing request, and a row whose companyId names another tenant's company —
   * which the lookup below can never resolve, because it is workspace-scoped.
   */
  it('treats an unresolvable companyId as ungrouped rather than naming it', async () => {
    seed([
      lead('l-ghost', 'c-0-other-workspace', '2026-01-09'),
      lead('l-acme-1', 'c-2', '2026-01-04'),
    ]);

    const res = await svc.findAll(WS, { sortBy: 'company' } as any, 'u1', 'OWNER');

    expect(res.data.map((r: any) => r.id)).toEqual(['l-acme-1', 'l-ghost']);
    expect(res.data.map((r: any) => r.company)).toEqual([
      { id: 'c-2', name: 'Acme AŞ' },
      null,
    ]);
  });

  it('scopes the company lookup to the workspace, so a name can never cross tenants', async () => {
    seed([lead('l-acme-1', 'c-2', '2026-01-04')]);

    await svc.findAll(WS, { sortBy: 'company' } as any, 'u1', 'OWNER');

    const where = (prisma.company.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.workspaceId).toBe(WS);
  });

  /**
   * The field is not conditional on the sort. The surface groups by reading
   * `company` off the rows it was handed, and a field that only appears under
   * one `sortBy` is a second shape of the same payload for every other caller
   * to guess at.
   */
  it('resolves `company` on the rows under any sort, and null when unlinked', async () => {
    (prisma.lead.findMany as jest.Mock).mockResolvedValue([
      lead('l-acme-1', 'c-2', '2026-01-04'),
      lead('l-none-1', null, '2026-01-03'),
    ] as any);
    prisma.lead.count.mockResolvedValue(2 as any);

    const res = await svc.findAll(WS, {} as any, 'u1', 'OWNER');

    expect(res.data.map((r: any) => r.company)).toEqual([{ id: 'c-2', name: 'Acme AŞ' }, null]);
  });

  it('does not read the companies table at all when nobody on the page has one', async () => {
    (prisma.lead.findMany as jest.Mock).mockResolvedValue([lead('l-none-1', null, '2026-01-03')] as any);
    prisma.lead.count.mockResolvedValue(1 as any);

    const res = await svc.findAll(WS, {} as any, 'u1', 'OWNER');

    expect(res.data[0].company).toBeNull();
    expect(prisma.company.findMany as jest.Mock).not.toHaveBeenCalled();
  });
});
