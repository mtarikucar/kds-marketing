import { CommerceTraceService } from './commerce-trace.service';
import { commerceActivity } from './commerce-activity';

const WS = 'ws-1';

function makeDeps() {
  const prisma: any = {
    lead: { findFirst: jest.fn().mockResolvedValue({ id: 'l1' }) },
    marketingUser: { findFirst: jest.fn().mockResolvedValue({ id: 'sentinel-1' }) },
    leadActivity: { create: jest.fn().mockResolvedValue({ id: 'act1' }) },
  };
  return { prisma };
}

const ROW = commerceActivity({
  event: 'invoice_paid',
  docId: 'inv1',
  number: 'INV-1',
  totalMinor: 5000,
  currency: 'TRY',
  paidVia: 'STRIPE',
});

describe('CommerceTraceService', () => {
  let d: ReturnType<typeof makeDeps>;
  let svc: CommerceTraceService;

  beforeEach(() => {
    d = makeDeps();
    svc = new CommerceTraceService(d.prisma as any);
  });

  it('writes the row on the person, carrying the mapper output verbatim', async () => {
    await svc.record(WS, 'l1', ROW, { actorId: 'u1' });
    expect(d.prisma.leadActivity.create).toHaveBeenCalledWith({
      data: {
        type: 'COMMERCE',
        title: 'Invoice INV-1 paid',
        description: ROW.description,
        metadata: ROW.metadata,
        leadId: 'l1',
        createdById: 'u1',
      },
    });
  });

  it('does nothing at all for a document with no contact behind it', async () => {
    // A walk-in sale: an invoice with leadId null has no person to write on.
    await svc.record(WS, null, ROW);
    expect(d.prisma.lead.findFirst).not.toHaveBeenCalled();
    expect(d.prisma.leadActivity.create).not.toHaveBeenCalled();
  });

  it('refuses to write onto another workspace lead id', async () => {
    d.prisma.lead.findFirst.mockResolvedValue(null);
    await svc.record(WS, 'someone-elses-lead', ROW, { actorId: 'u1' });
    expect(d.prisma.lead.findFirst).toHaveBeenCalledWith({
      where: { id: 'someone-elses-lead', workspaceId: WS },
      select: { id: true },
    });
    expect(d.prisma.leadActivity.create).not.toHaveBeenCalled();
  });

  it('falls back to the workspace SYSTEM sentinel when nobody clicked', async () => {
    // The customer paid on the public page; no colleague did this.
    await svc.record(WS, 'l1', ROW);
    expect(d.prisma.marketingUser.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: WS, role: 'SYSTEM' },
      select: { id: true },
    });
    expect(d.prisma.leadActivity.create.mock.calls[0][0].data.createdById).toBe('sentinel-1');
  });

  it('writes nothing when there is no author at all rather than violating the FK', async () => {
    // LeadActivity.createdById is required with onDelete: Restrict — a create
    // without an author throws inside whatever transaction called us.
    d.prisma.marketingUser.findFirst.mockResolvedValue(null);
    await svc.record(WS, 'l1', ROW);
    expect(d.prisma.leadActivity.create).not.toHaveBeenCalled();
  });

  it('never throws — a lost trace must not fail the payment that caused it', async () => {
    d.prisma.leadActivity.create.mockRejectedValue(new Error('db down'));
    await expect(svc.record(WS, 'l1', ROW, { actorId: 'u1' })).resolves.toBeUndefined();
  });

  it('caches a resolved sentinel per workspace, and never caches a miss', async () => {
    d.prisma.marketingUser.findFirst.mockResolvedValueOnce(null);
    await svc.record(WS, 'l1', ROW); // miss — must not be remembered
    d.prisma.marketingUser.findFirst.mockResolvedValue({ id: 'sentinel-1' });
    await svc.record(WS, 'l1', ROW); // resolves, and is remembered
    await svc.record(WS, 'l1', ROW);
    // Three calls, two lookups: the miss was retried, the hit was cached.
    expect(d.prisma.marketingUser.findFirst).toHaveBeenCalledTimes(2);
    expect(d.prisma.leadActivity.create).toHaveBeenCalledTimes(2);
  });
});
