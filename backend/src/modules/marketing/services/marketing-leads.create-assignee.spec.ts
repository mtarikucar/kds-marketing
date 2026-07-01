import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MarketingLeadsService } from './marketing-leads.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

/**
 * create() must apply the SAME assignee guard as assign()/bulkAssign(): an
 * explicit assignedToId may only point at an ACTIVE REP. Otherwise a manager can
 * mint a lead owned by a MANAGER or a deactivated rep — a state the dedicated
 * assign endpoints forbid — which then silently sits in no active queue and, on
 * convert, stamps a commission to a non-REP owner.
 */
describe('MarketingLeadsService — create() assignee guard', () => {
  let prisma: MockPrismaClient;
  let svc: MarketingLeadsService;

  const baseDto = {
    businessName: 'X',
    contactPerson: 'Y',
    businessType: 'CAFE',
    source: 'WEBSITE',
  };

  beforeEach(() => {
    prisma = mockPrismaClient();
    const cf = { validateAndNormalize: jest.fn().mockResolvedValue({}) };
    svc = new MarketingLeadsService(
      prisma as any,
      {} as any, // emailService
      { pickAssignee: jest.fn().mockResolvedValue(null) } as any, // autoAssigner
      {} as any, // provisioning
      { append: jest.fn().mockResolvedValue('o') } as any, // outbox
      cf as any, // customFields
      { verify: jest.fn().mockResolvedValue('VALID') } as any, // hygiene
    );
    prisma.lead.findFirst.mockResolvedValue(null); // no dedup match
    prisma.lead.create.mockResolvedValue({ id: 'lead-1' } as any);
  });

  it('rejects assigning a new lead to a non-REP (MANAGER) — parity with assign()', async () => {
    prisma.marketingUser.findFirst.mockResolvedValue({ id: 'mgr-2', role: 'MANAGER', status: 'ACTIVE' } as any);
    await expect(
      svc.create('ws-1', { ...baseDto, assignedToId: 'mgr-2' } as any, 'u1', 'OWNER'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('rejects assigning a new lead to an INACTIVE rep — parity with assign()', async () => {
    prisma.marketingUser.findFirst.mockResolvedValue({ id: 'rep-2', role: 'REP', status: 'INACTIVE' } as any);
    await expect(
      svc.create('ws-1', { ...baseDto, assignedToId: 'rep-2' } as any, 'u1', 'OWNER'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('still 404s an assignee from another workspace', async () => {
    prisma.marketingUser.findFirst.mockResolvedValue(null as any);
    await expect(
      svc.create('ws-1', { ...baseDto, assignedToId: 'foreign' } as any, 'u1', 'OWNER'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('allows assigning a new lead to an ACTIVE REP', async () => {
    prisma.marketingUser.findFirst.mockResolvedValue({ id: 'rep-2', role: 'REP', status: 'ACTIVE' } as any);
    await svc.create('ws-1', { ...baseDto, assignedToId: 'rep-2' } as any, 'u1', 'OWNER');
    expect(prisma.lead.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ assignedToId: 'rep-2' }) }),
    );
  });
});
