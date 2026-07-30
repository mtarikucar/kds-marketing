/**
 * Seed/rotate a platform operator (superadmin realm).
 *
 *   PLATFORM_OPERATOR_EMAIL=ops@example.com \
 *   PLATFORM_OPERATOR_PASSWORD='change-me-now' \
 *   PLATFORM_OPERATOR_NAME='Ops' \
 *   npx ts-node prisma/seed-platform-operator.ts
 *
 * Upserts on email: existing operator gets the new password/name (and a
 * tokenVersion bump so old sessions die); a fresh database gets its first
 * operator.
 *
 * Env contract (mirrors seed-operator-workspace.ts): BOTH vars unset = NO-OP,
 * exit 0 — the deploy runs this on every boot and an environment that doesn't
 * want a seeded superadmin must not see a failure. Exactly one of the two set,
 * or a too-short password, is a misconfiguration → error + exit 1.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

export type OperatorSeedOutcome = 'skipped' | 'ready';

type OperatorSeedClient = Pick<PrismaClient, 'platformOperator'>;

interface SeedLogger {
  log: (message: string) => void;
  error: (message: string) => void;
}

export async function seedPlatformOperator(
  prisma: OperatorSeedClient,
  env: Record<string, string | undefined> = process.env,
  logger: SeedLogger = console,
): Promise<OperatorSeedOutcome> {
  const email = (env.PLATFORM_OPERATOR_EMAIL ?? '').trim();
  const password = env.PLATFORM_OPERATOR_PASSWORD ?? '';
  const name = env.PLATFORM_OPERATOR_NAME ?? 'Platform Operator';

  if (!email && !password) {
    logger.log(
      'PLATFORM_OPERATOR_EMAIL/PASSWORD not set — skipping the platform operator seed.',
    );
    return 'skipped';
  }
  if (!email || !password) {
    throw new Error(
      'PLATFORM_OPERATOR_EMAIL and PLATFORM_OPERATOR_PASSWORD must be set together.',
    );
  }
  if (password.length < 12) {
    throw new Error('Operator password must be at least 12 characters.');
  }

  const costRaw = env.BCRYPT_COST;
  const parsed = costRaw ? parseInt(costRaw, 10) : NaN;
  const cost =
    Number.isFinite(parsed) && parsed >= 10 && parsed <= 15 ? parsed : 12;
  const hash = await bcrypt.hash(password, cost);

  const operator = await prisma.platformOperator.upsert({
    where: { email },
    create: { email, password: hash, name },
    update: {
      password: hash,
      name,
      status: 'ACTIVE',
      failedLogins: 0,
      lockedUntil: null,
      tokenVersion: { increment: 1 },
    },
    select: { id: true, email: true, name: true },
  });

  logger.log(`Platform operator ready: ${operator.email} (${operator.id})`);
  return 'ready';
}

async function main() {
  const prisma = new PrismaClient();
  try {
    await seedPlatformOperator(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
