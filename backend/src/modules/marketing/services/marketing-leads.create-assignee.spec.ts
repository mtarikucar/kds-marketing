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
      {} as any, // smsOtp — unused here
    );
    prisma.lead.findFirst.mockResolvedValue(null); // no dedup match
    prisma.lead.create.mockResolvedValue({ id: 'lead-1' } as any);
  });

  it('rejects assigning a new lead to a non-REP (MANAGER) — parity with assign()', async () => {
    prisma.workspaceMembership.findFirst.mockResolvedValue({ role: 'MANAGER', status: 'ACTIVE', user: { id: 'mgr-2', firstName: 'M', lastName: 'G' } } as any);
    await expect(
      svc.create('ws-1', { ...baseDto, assignedToId: 'mgr-2' } as any, 'u1', 'OWNER'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('rejects assigning a new lead to an INACTIVE rep — parity with assign()', async () => {
    prisma.workspaceMembership.findFirst.mockResolvedValue({ role: 'REP', status: 'SUSPENDED', user: { id: 'rep-2', firstName: 'R', lastName: 'P' } } as any);
    await expect(
      svc.create('ws-1', { ...baseDto, assignedToId: 'rep-2' } as any, 'u1', 'OWNER'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('still 404s an assignee from another workspace', async () => {
    prisma.workspaceMembership.findFirst.mockResolvedValue(null as any);
    await expect(
      svc.create('ws-1', { ...baseDto, assignedToId: 'foreign' } as any, 'u1', 'OWNER'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('allows assigning a new lead to an ACTIVE REP', async () => {
    prisma.workspaceMembership.findFirst.mockResolvedValue({ role: 'REP', status: 'ACTIVE', user: { id: 'rep-2', firstName: 'R', lastName: 'P' } } as any);
    await svc.create('ws-1', { ...baseDto, assignedToId: 'rep-2' } as any, 'u1', 'OWNER');
    expect(prisma.lead.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ assignedToId: 'rep-2' }) }),
    );
  });
});

/**
 * The guard must read the SOURCE OF TRUTH. MarketingUsersService.update()
 * writes role/status only to WorkspaceMembership — the MarketingUser columns
 * are frozen at creation — so reading those refused a promoted REP and, worse,
 * ACCEPTED a demoted one, stamping a commission on convert to someone who is
 * no longer a rep: the exact harm this guard exists to prevent.
 */
describe('MarketingLeadsService — assignee eligibility reads the membership', () => {
  let prisma: MockPrismaClient;
  let svc: MarketingLeadsService;
  const baseDto = { businessName: 'X', contactPerson: 'Y', businessType: 'CAFE', source: 'WEBSITE' };

  beforeEach(() => {
    prisma = mockPrismaClient();
    svc = new MarketingLeadsService(
      prisma as any, {} as any,
      { pickAssignee: jest.fn().mockResolvedValue(null) } as any,
      {} as any, { append: jest.fn().mockResolvedValue('o') } as any,
      { validateAndNormalize: jest.fn().mockResolvedValue({}) } as any,
      { verify: jest.fn().mockResolvedValue('VALID') } as any,
      {} as any,
    );
    prisma.lead.findFirst.mockResolvedValue(null);
    prisma.lead.create.mockResolvedValue({ id: 'lead-1' } as any);
  });

  it('ACCEPTS a user PROMOTED to REP on their membership (stale user row said MANAGER)', async () => {
    prisma.workspaceMembership.findFirst.mockResolvedValue({
      role: 'REP', status: 'ACTIVE', user: { id: 'promoted', firstName: 'P', lastName: 'R' },
    } as any);

    await svc.create('ws-1', { ...baseDto, assignedToId: 'promoted' } as any, 'u1', 'OWNER');

    expect(prisma.lead.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ assignedToId: 'promoted' }) }),
    );
  });

  it('REFUSES a user DEMOTED from REP on their membership (stale user row said REP)', async () => {
    prisma.workspaceMembership.findFirst.mockResolvedValue({
      role: 'MANAGER', status: 'ACTIVE', user: { id: 'demoted', firstName: 'D', lastName: 'M' },
    } as any);

    await expect(
      svc.create('ws-1', { ...baseDto, assignedToId: 'demoted' } as any, 'u1', 'OWNER'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('never reads the frozen MarketingUser columns for eligibility', async () => {
    prisma.workspaceMembership.findFirst.mockResolvedValue({
      role: 'REP', status: 'ACTIVE', user: { id: 'rep-x', firstName: 'R', lastName: 'X' },
    } as any);

    await svc.create('ws-1', { ...baseDto, assignedToId: 'rep-x' } as any, 'u1', 'OWNER');

    expect(prisma.marketingUser.findFirst).not.toHaveBeenCalled();
  });
});
