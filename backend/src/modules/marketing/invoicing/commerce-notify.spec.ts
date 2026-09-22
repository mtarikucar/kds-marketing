import { notifyCommerce } from './commerce-notify';

const WS = 'ws-1';

function makePrisma() {
  return {
    lead: { findFirst: jest.fn().mockResolvedValue(null) },
    workspaceMembership: { findFirst: jest.fn().mockResolvedValue(null) },
    marketingNotification: { create: jest.fn().mockResolvedValue({ id: 'n1' }) },
  };
}

const NOTICE = {
  workspaceId: WS,
  leadId: 'lead-1',
  type: 'QUOTE_ANSWERED',
  title: 'Quote EST-7 accepted',
  message: 'The customer accepted quote EST-7.',
  metadata: { docId: 'est-1' },
};

describe('notifyCommerce', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
  });

  it('tells the rep who owns the person, when there is one', async () => {
    prisma.lead.findFirst.mockResolvedValue({ assignedToId: 'rep-1' });

    const userId = await notifyCommerce(prisma as any, NOTICE);

    expect(userId).toBe('rep-1');
    expect(prisma.lead.findFirst).toHaveBeenCalledWith({
      where: { id: 'lead-1', workspaceId: WS },
      select: { assignedToId: true },
    });
    const arg = prisma.marketingNotification.create.mock.calls[0][0];
    expect(arg.data).toMatchObject({
      workspaceId: WS,
      userId: 'rep-1',
      type: 'QUOTE_ANSWERED',
      title: 'Quote EST-7 accepted',
    });
    expect(arg.data.metadata).toMatchObject({ leadId: 'lead-1', docId: 'est-1' });
    expect(prisma.workspaceMembership.findFirst).not.toHaveBeenCalled();
  });

  // The owner is resolved through the MEMBERSHIP, never `MarketingUser.
  // workspaceId` — that column is the user's HOME workspace, so an owner whose
  // home is elsewhere would be silently dropped and the money moment would be
  // announced to nobody.
  it('falls back to the workspace OWNER, resolved through the membership', async () => {
    prisma.lead.findFirst.mockResolvedValue({ assignedToId: null });
    prisma.workspaceMembership.findFirst.mockResolvedValue({ userId: 'owner-1' });

    const userId = await notifyCommerce(prisma as any, NOTICE);

    expect(userId).toBe('owner-1');
    expect(prisma.workspaceMembership.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WS, role: 'OWNER', status: 'ACTIVE' },
      }),
    );
    expect(prisma.marketingNotification.create.mock.calls[0][0].data.userId).toBe('owner-1');
  });

  it('does not look for a lead when the document has no contact', async () => {
    prisma.workspaceMembership.findFirst.mockResolvedValue({ userId: 'owner-1' });

    await notifyCommerce(prisma as any, { ...NOTICE, leadId: null });

    expect(prisma.lead.findFirst).not.toHaveBeenCalled();
    expect(prisma.marketingNotification.create.mock.calls[0][0].data.userId).toBe('owner-1');
  });

  it('writes nothing, and says so, when the workspace has nobody to tell', async () => {
    prisma.lead.findFirst.mockResolvedValue({ assignedToId: null });

    await expect(notifyCommerce(prisma as any, NOTICE)).resolves.toBeNull();
    expect(prisma.marketingNotification.create).not.toHaveBeenCalled();
  });

  // It runs after the money already moved (a paid invoice, a signed agreement).
  // A bell that cannot be rung must never look like a failed payment.
  it('never throws — the moment it announces has already happened', async () => {
    prisma.lead.findFirst.mockRejectedValue(new Error('db down'));
    const logger = { warn: jest.fn() };

    await expect(notifyCommerce(prisma as any, NOTICE, logger)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('swallows a failing notification write too', async () => {
    prisma.lead.findFirst.mockResolvedValue({ assignedToId: 'rep-1' });
    prisma.marketingNotification.create.mockRejectedValue(new Error('constraint'));

    await expect(notifyCommerce(prisma as any, NOTICE)).resolves.toBeNull();
  });
});
