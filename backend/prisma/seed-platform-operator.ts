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
 * operator. Deliberately NOT part of `prisma db seed` — creating superadmins
 * should be an explicit ops action.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.PLATFORM_OPERATOR_EMAIL;
  const password = process.env.PLATFORM_OPERATOR_PASSWORD;
  const name = process.env.PLATFORM_OPERATOR_NAME ?? 'Platform Operator';

  if (!email || !password) {
    console.error(
      'PLATFORM_OPERATOR_EMAIL and PLATFORM_OPERATOR_PASSWORD are required.',
    );
    process.exit(1);
  }
  if (password.length < 12) {
    console.error('Operator password must be at least 12 characters.');
    process.exit(1);
  }

  const costRaw = process.env.BCRYPT_COST;
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

  console.log(`Platform operator ready: ${operator.email} (${operator.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
