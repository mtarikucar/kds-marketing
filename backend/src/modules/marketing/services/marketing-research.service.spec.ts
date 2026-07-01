import { BadRequestException } from '@nestjs/common';
import { MarketingResearchService } from './marketing-research.service';
import { mockPrismaClient } from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc(maxResearchProfiles: number) {
  const prisma = mockPrismaClient();
  (prisma.$transaction as any).mockImplementation(async (fn: any) => fn(prisma));
  (prisma.$queryRawUnsafe as any).mockResolvedValue([{ locked: 'x' }]);
  const ingest = {} as any;
  const entitlements = { getEffective: jest.fn().mockResolvedValue({ maxResearchProfiles }) } as any;
  const svc = new MarketingResearchService(prisma as any, ingest, entitlements);
  return { prisma, svc };
}

const DTO = { name: 'ICP', icpDescription: 'desc' } as any;

// A bare count-then-create lets two concurrent requests at (max-1) BOTH pass the cap
// and exceed maxResearchProfiles. The create serializes the check under a per-
// workspace advisory xact-lock (the ai-credits / message-quota quota pattern).
describe('MarketingResearchService.create — profile-cap race safety', () => {
  it('serializes the count-check + create under a per-workspace advisory lock', async () => {
    const { prisma, svc } = makeSvc(5);
    (prisma.researchProfile.count as jest.Mock).mockResolvedValue(4); // room for one
    (prisma.researchProfile.create as jest.Mock).mockResolvedValue({ id: 'p1' });

    await svc.create(WS, DTO);

    expect(prisma.$transaction).toHaveBeenCalled();
    const lockSql = (prisma.$queryRawUnsafe as jest.Mock).mock.calls[0][0] as string;
    expect(lockSql).toContain('pg_advisory_xact_lock');
    expect(lockSql).toContain('research-profiles:ws-1');
    expect(prisma.researchProfile.create).toHaveBeenCalled();
  });

  it('rejects at the cap without creating (checked inside the lock)', async () => {
    const { prisma, svc } = makeSvc(5);
    (prisma.researchProfile.count as jest.Mock).mockResolvedValue(5); // at cap

    await expect(svc.create(WS, DTO)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.researchProfile.create).not.toHaveBeenCalled();
  });

  it('skips the lock/count on an unlimited (-1) plan', async () => {
    const { prisma, svc } = makeSvc(-1);
    (prisma.researchProfile.create as jest.Mock).mockResolvedValue({ id: 'p1' });

    await svc.create(WS, DTO);

    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.researchProfile.create).toHaveBeenCalled();
  });
});
