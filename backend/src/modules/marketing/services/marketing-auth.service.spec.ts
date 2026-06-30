import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MarketingAuthService } from './marketing-auth.service';

/**
 * registerWorkspace pre-checks the owner email, then provisions the workspace
 * (owner + sentinel + config + trial) in a transaction. The email/slug unique
 * indexes are the real arbiters under concurrency — two simultaneous signups
 * that both pass the pre-check race on INSERT. The loser must surface a clean
 * 409, not leak the raw Prisma P2002 as a 500.
 */
describe('MarketingAuthService.registerWorkspace — concurrent-duplicate → 409', () => {
  const DTO = {
    email: 'owner@acme.test',
    password: 'sufficiently-long-pw',
    firstName: 'Ada',
    lastName: 'Lovelace',
    workspaceName: 'Acme',
    productName: 'Acme CRM',
  } as never;

  function make() {
    const prisma = {
      marketingUser: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(),
    };
    const jwt = { sign: jest.fn().mockReturnValue('tok') };
    const config = { get: jest.fn().mockReturnValue(undefined) };
    const svc = new MarketingAuthService(prisma as never, jwt as never, config as never);
    return { prisma, svc };
  }

  const p2002 = (target: string[]) =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target },
    });

  it('maps a racing duplicate-email P2002 to a ConflictException', async () => {
    const { prisma, svc } = make();
    prisma.$transaction.mockRejectedValue(p2002(['email']));
    await expect(svc.registerWorkspace(DTO)).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a racing duplicate-slug P2002 to a ConflictException', async () => {
    const { prisma, svc } = make();
    prisma.$transaction.mockRejectedValue(p2002(['slug']));
    await expect(svc.registerWorkspace(DTO)).rejects.toBeInstanceOf(ConflictException);
  });
});
