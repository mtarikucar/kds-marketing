import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { PrismaClient } from '@prisma/client';
import { OnboardingService } from './onboarding.service';
import { WorkspaceBusinessTypesService } from './workspace-business-types.service';

// A unique schema isolates fixtures from application data. The table DDL comes
// from the actual migration so raw column names are checked against the database.
const databaseUrl = process.env.BUSINESS_TYPES_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)(
  'Workspace business types PostgreSQL preservation',
  () => {
    const schema = `business_types_${randomUUID().replace(/-/g, '')}`;
    let admin: PrismaClient;
    let prisma: PrismaClient;
    beforeAll(async () => {
      admin = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
      const url = new URL(databaseUrl!);
      url.searchParams.set('schema', schema);
      prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
      await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      const migration = readFileSync(
        resolve(
          __dirname,
          '../../../../prisma/migrations/20260610100000_workspaces_init/migration.sql',
        ),
        'utf8',
      );
      await prisma.$executeRawUnsafe(
        migration.match(/CREATE TABLE "workspaces" \([\s\S]*?\);/)![0],
      );
      await prisma.$executeRawUnsafe('CREATE TABLE leads (id text PRIMARY KEY, "workspaceId" text, "businessType" text)');
    });
    afterAll(async () => {
      await prisma?.$disconnect();
      if (admin) {
        await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.$disconnect();
      }
    });

    it('preserves unrelated keys, scopes reads/writes, and initializes SQL/JSON null settings', async () => {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
        INSERT INTO workspaces (id, slug, name, "productName", "updatedAt", settings)
        SELECT id, id, id, 'Test product', NOW(), settings FROM (VALUES
        ('own', '{"businessTypes":["OLD"],"brandColor":"blue","nested":{"keep":true}}'::jsonb),
        ('neighbor', '{"businessTypes":["LEGACY_NEIGHBOR"]}'::jsonb),
        ('sql-null', NULL), ('json-null', 'null'::jsonb)
        ) AS fixtures(id, settings)
      `;
        await tx.$executeRaw`INSERT INTO leads VALUES
          ('l1', 'own', 'RETIRED'), ('l2', 'own', 'RETIRED'),
          ('l3', 'neighbor', 'FOREIGN'), ('l4', 'own', '')`;
        const service = new WorkspaceBusinessTypesService(tx as any);
        expect(await service.set('own', ['CUSTOM_TYPE'])).toEqual({
          businessTypes: ['CUSTOM_TYPE'],
        });
        expect(await service.get('own')).toEqual({
          businessTypes: ['CUSTOM_TYPE'], historicalBusinessTypes: ['RETIRED'],
        });
        expect(await service.get('neighbor')).toEqual({
          businessTypes: ['LEGACY_NEIGHBOR'], historicalBusinessTypes: ['FOREIGN'],
        });
        const rows = await tx.$queryRaw<
          any[]
        >`SELECT settings FROM workspaces WHERE id = 'own'`;
        expect(rows[0].settings).toEqual({
          businessTypes: ['CUSTOM_TYPE'],
          brandColor: 'blue',
          nested: { keep: true },
        });
        for (const id of ['sql-null', 'json-null']) {
          expect(await service.get(id)).toEqual({ businessTypes: ['OTHER'] });
          expect(await service.set(id, ['NEW'])).toEqual({
            businessTypes: ['NEW'],
          });
          expect(await service.get(id)).toEqual({ businessTypes: ['NEW'] });
        }
      });
    });
    it('preserves taxonomy committed while onboarding is waiting on the same row', async () => {
      await prisma.$executeRaw`INSERT INTO workspaces (id, slug, name, "productName", "updatedAt", settings)
        VALUES ('race', 'race', 'Race', 'Test', NOW(), '{"businessTypes":["OLD"],"onboarding":{"other":"keep"},"brandColor":"blue"}'::jsonb)`;
      let updateStarted: () => void;
      const started = new Promise<void>((resolve) => { updateStarted = resolve; });
      // Observe the DB boundary without replacing any SQL execution. With the
      // old read/merge/write, its read sees OLD before its UPDATE waits on our lock.
      const onboarding = new OnboardingService({
        $executeRaw: (...args: any[]) => { updateStarted(); return (prisma.$executeRaw as any)(...args); },
        workspace: {
          findUnique: (args: any) => prisma.workspace.findUnique(args),
          update: (args: any) => { updateStarted(); return prisma.workspace.update({ ...args, select: { id: true } }); },
        },
      } as any);
      let dismissal: Promise<unknown>;
      await prisma.$transaction(async (tx) => {
        await new WorkspaceBusinessTypesService(tx as any).set('race', ['NEW']);
        dismissal = onboarding.setDismissed('race', true);
        await started;
      });
      await dismissal!;
      const workspace = await prisma.workspace.findUnique({ where: { id: 'race' }, select: { settings: true } });
      expect(workspace?.settings).toEqual({ businessTypes: ['NEW'], onboarding: { dismissed: true, other: 'keep' }, brandColor: 'blue' });
    });

  },
);
