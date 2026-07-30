import * as bcrypt from 'bcryptjs';
import { seedPlatformOperator } from '../../../prisma/seed-platform-operator';

function makePrisma() {
  return {
    platformOperator: {
      upsert: jest
        .fn()
        .mockResolvedValue({ id: 'op-1', email: 'ops@x.com', name: 'Ops' }),
    },
  } as any;
}

function makeLog() {
  return { log: jest.fn(), error: jest.fn() };
}

// Cheapest legal cost — the seed clamps anything outside 10..15 back to 12.
const FAST = { BCRYPT_COST: '10' };

describe('seedPlatformOperator (deploy-time, env-gated)', () => {
  it('no-ops when neither credential var is set (safe on every deploy)', async () => {
    const prisma = makePrisma();
    const log = makeLog();
    expect(await seedPlatformOperator(prisma, {}, log)).toBe('skipped');
    expect(prisma.platformOperator.upsert).not.toHaveBeenCalled();
    expect(log.log).toHaveBeenCalledWith(
      expect.stringContaining('PLATFORM_OPERATOR_EMAIL'),
    );
  });

  it('errors when only one of the two is set (misconfiguration, not an opt-out)', async () => {
    const prisma = makePrisma();
    await expect(
      seedPlatformOperator(prisma, { PLATFORM_OPERATOR_EMAIL: 'ops@x.com' }, makeLog()),
    ).rejects.toThrow(/must be set together/);
    expect(prisma.platformOperator.upsert).not.toHaveBeenCalled();
  });

  it('rejects a short password', async () => {
    const prisma = makePrisma();
    await expect(
      seedPlatformOperator(
        prisma,
        { PLATFORM_OPERATOR_EMAIL: 'ops@x.com', PLATFORM_OPERATOR_PASSWORD: 'short' },
        makeLog(),
      ),
    ).rejects.toThrow(/at least 12 characters/);
  });

  it('upserts a bcrypt-hashed operator and bumps tokenVersion on rotation', async () => {
    const prisma = makePrisma();
    const outcome = await seedPlatformOperator(
      prisma,
      {
        ...FAST,
        PLATFORM_OPERATOR_EMAIL: 'ops@x.com',
        PLATFORM_OPERATOR_PASSWORD: 'a-long-enough-password',
        PLATFORM_OPERATOR_NAME: 'Ops',
      },
      makeLog(),
    );

    expect(outcome).toBe('ready');
    const args = prisma.platformOperator.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ email: 'ops@x.com' });
    expect(args.create.password).not.toBe('a-long-enough-password');
    expect(
      await bcrypt.compare('a-long-enough-password', args.create.password),
    ).toBe(true);
    expect(args.update.tokenVersion).toEqual({ increment: 1 });
    expect(args.update.lockedUntil).toBeNull();
  });
});
