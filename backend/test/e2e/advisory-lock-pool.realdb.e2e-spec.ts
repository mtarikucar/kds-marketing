import { randomUUID } from 'crypto';
import { PrismaService } from '../../src/prisma/prisma.service';
import {
  withAdvisoryLock,
  withAdvisoryXactLock,
} from '../../src/common/scheduling/advisory-lock';
import { realDbEnabled } from '../utils/test-app';

/**
 * The cron locks, against a REAL connection pool.
 *
 * Both lock helpers hold their lock in an interactive transaction — one pooled
 * connection pinned for the whole body — and the body runs its own queries on
 * the SAME pool. So the moment as many locked jobs are inside as the pool has
 * connections, every connection is a transaction waiting on its body and every
 * body is waiting on a connection. Nothing moves until `pool_timeout` fails all
 * of them, together with any request that arrived in between.
 *
 * That is not a thought experiment. CI's pool is 5, and every :X0 tick starts
 * eleven locked crons. backend-realdb went red three times in four days, each
 * time exactly ten seconds — CI's pool_timeout — after a :X0 tick, each time on
 * a P2024 in whichever suite happened to be mid-query:
 *
 *   2026-10-26 12:40:10  email journey        (POST …/email → 500)
 *   2026-10-28 08:10:10  content programme
 *   2026-10-29 14:20:10  AI reply pre-flight  (message.create)
 *
 * Production saw the same storm at the top of the hour (26 P2024 bursts in six
 * hours, see deploy.yml) and got a bigger pool: 40, against 34 locked crons at
 * :00. That moved the cliff, it did not remove it.
 *
 * A mocked `$transaction` cannot show any of this: it has no pool. This one does
 * — two connections, so a burst of four locks is twice the pool.
 *
 * Opt-in via E2E_REAL_DB=1.
 */
const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('cron advisory locks — real connection pool (e2e)', () => {
  const POOL = 2;
  const BURST = 4;
  const run = randomUUID().slice(0, 8);
  let prisma: PrismaService;

  beforeAll(async () => {
    // PrismaService reads DATABASE_URL in its constructor; point it at the same
    // database with a pool of two that gives up after 3 s, then put it back.
    const ambient = process.env.DATABASE_URL;
    const url = new URL(ambient!);
    url.searchParams.set('connection_limit', String(POOL));
    url.searchParams.set('pool_timeout', '3');
    process.env.DATABASE_URL = url.toString();
    try {
      prisma = new PrismaService();
    } finally {
      process.env.DATABASE_URL = ambient;
    }
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.cronHeartbeat.deleteMany({ where: { jobName: { startsWith: `pool-burst:${run}:` } } });
    await prisma.$disconnect();
  });

  it.each([
    ['withAdvisoryLock', withAdvisoryLock],
    ['withAdvisoryXactLock', withAdvisoryXactLock],
  ] as const)(
    '%s: a burst of jobs twice the pool runs every body, and a query in the middle of it is served',
    async (helper, lock) => {
      // Every body waits until a pool's worth of bodies are inside — or a beat
      // passes — and only THEN queries. Unbounded, that wait makes the deadlock
      // certain: by the time any body asks for a connection, all of them are
      // lock transactions. Bounded, the permitted few get in, the beat passes,
      // and they finish one after another.
      let inside = 0;
      let ran = 0;
      let poolFull!: () => void;
      const poolIsFull = new Promise<void>((resolve) => (poolFull = resolve));
      let firstIn!: () => void;
      const someoneIsIn = new Promise<void>((resolve) => (firstIn = resolve));

      const body = async () => {
        inside += 1;
        firstIn();
        if (inside >= POOL) poolFull();
        await Promise.race([poolIsFull, new Promise((resolve) => setTimeout(resolve, 250))]);
        await prisma.$queryRaw`SELECT 1`;
        ran += 1;
      };

      const burst = Promise.allSettled(
        Array.from({ length: BURST }, (_, i) => lock(prisma, `pool-burst:${run}:${helper}:${i}`, body)),
      );

      // A request that lands while the locks are held — the query the
      // pre-flight spec was making when it died.
      await someoneIsIn;
      await prisma.$queryRaw`SELECT 1`;

      const failures = (await burst)
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => (r.reason as Error).message);
      expect(failures).toEqual([]);
      expect(ran).toBe(BURST);
    },
  );
});
