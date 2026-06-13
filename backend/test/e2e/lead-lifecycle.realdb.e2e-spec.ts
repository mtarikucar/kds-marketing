import { randomUUID, createHash } from 'crypto';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CORE_PROVISIONING_PORT } from '../../src/core-contracts/provisioning/tenant-provisioning.port';
import {
  createRealDbTestApp,
  closeTestApp,
  realDbEnabled,
  signMarketingToken,
} from '../utils/test-app';

/**
 * The full lead lifecycle against REAL Postgres (backlog #7):
 *
 *   ingest (x-ingest-token) → assign (manager) → convert (manager) → commission
 *
 * Every step is a real HTTP request through the production pipeline, and every
 * assertion reads the actual rows back — so this is the data-consistency guard
 * the mocked suite can't be: the lead really transitions NEW→WON, the
 * convertedTenantId is really written, and a SIGNUP commission row really
 * materializes for the assigned rep with the amount derived from the plan facts.
 *
 * Only the cross-context CoreProvisioningPort is stubbed (it would otherwise call
 * the core service over the network); everything marketing-owned is real.
 *
 * Opt-in via E2E_REAL_DB=1 — skipped (with the whole describe) otherwise, so the
 * default DB-less e2e suite and CI are untouched.
 */
const SEED = `e2e-${randomUUID().slice(0, 8)}`;
const RAW_INGEST_TOKEN = `mkt_live_${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`.slice(0, 57);
const EXTERNAL_REF = 'phone:+905551112233';

const describeRealDb = realDbEnabled() ? describe : describe.skip;

describeRealDb('Lead lifecycle — real DB (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  const workspaceId = randomUUID();
  const packageId = randomUUID();
  const managerId = randomUUID();
  const repId = randomUUID();
  let leadId: string;
  let tenantId: string;

  const provisioningStub = {
    provisionTenantForLead: jest.fn(async () => ({
      tenantId: `tenant-${SEED}`,
      adminUserId: `admin-${SEED}`,
      subscriptionId: `sub-${SEED}`,
      subdomain: SEED,
      adminTempPassword: '', // empty → conversion skips the welcome email
      planFacts: { monthlyPrice: 100, commissionRate: 0.1, planCode: 'PRO' },
      created: true,
    })),
    listProvisionedLeads: jest.fn(async () => []),
    describePlan: jest.fn(async () => null),
  };

  beforeAll(async () => {
    if (!realDbEnabled()) return;

    ({ app, prisma } = await createRealDbTestApp((builder) =>
      builder.overrideProvider(CORE_PROVISIONING_PORT).useValue(provisioningStub),
    ));

    // --- Seed the marketing-owned graph the lifecycle needs ---
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        slug: SEED,
        name: 'Acme E2E',
        productName: 'Acme POS',
        status: 'ACTIVE',
      },
    });

    // Package + ACTIVE subscription → a non-zero dailyLeadQuota so ingest admits.
    await prisma.package.create({
      data: {
        id: packageId,
        code: `PKG-${SEED}`,
        name: 'E2E Plan',
        dailyLeadQuota: 100,
        maxUsers: 50,
        maxResearchProfiles: 10,
        features: { commissions: true },
        limits: {},
        priceMonthlyTRY: 0,
        priceMonthlyUSD: 0,
      },
    });
    const now = new Date();
    await prisma.workspaceSubscription.create({
      data: {
        workspaceId,
        packageId,
        status: 'ACTIVE',
        currency: 'USD',
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
      },
    });

    await prisma.marketingUser.createMany({
      data: [
        {
          id: managerId,
          workspaceId,
          email: `manager-${SEED}@example.com`,
          password: 'seed-not-a-real-hash',
          firstName: 'Mona',
          lastName: 'Manager',
          role: 'MANAGER',
          status: 'ACTIVE',
          tokenVersion: 0,
        },
        {
          id: repId,
          workspaceId,
          email: `rep-${SEED}@example.com`,
          password: 'seed-not-a-real-hash',
          firstName: 'Remy',
          lastName: 'Rep',
          role: 'REP',
          status: 'ACTIVE',
          tokenVersion: 0,
        },
        {
          // The SYSTEM sentinel the ingest path attributes auto-created
          // activities to (normally minted at workspace provisioning time).
          id: randomUUID(),
          workspaceId,
          email: `system-${SEED}@example.com`,
          password: 'seed-not-a-real-hash',
          firstName: 'System',
          lastName: 'Sentinel',
          role: 'SYSTEM',
          status: 'ACTIVE',
          tokenVersion: 0,
        },
      ],
    });

    await prisma.ingestToken.create({
      data: {
        workspaceId,
        tokenHash: createHash('sha256').update(RAW_INGEST_TOKEN, 'utf8').digest('hex'),
        tokenPrefix: RAW_INGEST_TOKEN.slice(0, 12),
        label: 'e2e',
        status: 'ACTIVE',
      },
    });
  });

  afterAll(async () => {
    if (!realDbEnabled() || !prisma) return;
    // Teardown in FK-safe order, each step tolerant so one failure can't strand
    // the rest (which would leak rows into the shared DB and collide next run).
    //   - Commission.marketingUser is onDelete:Restrict → delete commissions
    //     BEFORE users.
    //   - Lead→LeadActivity is onDelete:Cascade → deleting leads removes the
    //     activities that hold a Restrict FK to the SYSTEM user, so users delete
    //     cleanly afterward (no need to gate on leadId).
    const del = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* best-effort cleanup — never let teardown throw */
      }
    };
    try {
      await del(() => prisma.commission.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.lead.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.usageCounter.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.ingestToken.deleteMany({ where: { workspaceId } }));
      await del(() =>
        prisma.outboxEvent.deleteMany({ where: { tenantId: `tenant-${SEED}` } }),
      );
      await del(() => prisma.workspaceSubscription.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.marketingUser.deleteMany({ where: { workspaceId } }));
      await del(() => prisma.package.deleteMany({ where: { id: packageId } }));
      await del(() => prisma.workspace.deleteMany({ where: { id: workspaceId } }));
    } finally {
      await closeTestApp(app);
    }
  });

  const managerAuth = () =>
    `Bearer ${signMarketingToken({ sub: managerId, wsp: workspaceId, role: 'MANAGER' })}`;

  it('1) ingests a new lead via the per-workspace ingest token', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/marketing/leads/ingest')
      .set('x-ingest-token', RAW_INGEST_TOKEN)
      .send({
        leads: [
          {
            externalRef: EXTERNAL_REF,
            businessName: 'Bella Trattoria',
            businessType: 'RESTAURANT',
            painPoint: 'No online ordering, losing dinner rush orders',
            evidence: 'Instagram DMs asking for delivery',
            pitch: 'Launch online ordering in a week',
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);

    // The row really exists, scoped to the token's workspace, in NEW status.
    const lead = await prisma.lead.findFirstOrThrow({
      where: { workspaceId, externalRef: EXTERNAL_REF },
    });
    expect(lead.status).toBe('NEW');
    expect(lead.businessName).toBe('Bella Trattoria');
    leadId = lead.id;
  });

  it('2) a manager assigns the lead to a rep', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/api/marketing/leads/${leadId}/assign`)
      .set('Authorization', managerAuth())
      .send({ assignedToId: repId });

    expect(res.status).toBe(200);

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.assignedToId).toBe(repId);
  });

  it('3) a manager converts the lead → tenant provisioned, lead WON', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/marketing/leads/${leadId}/convert`)
      .set('Authorization', managerAuth())
      .send({
        planId: randomUUID(), // validated as a UUID by the DTO; CORE port is stubbed
        tenantName: 'Bella Trattoria',
        adminEmail: `owner-${SEED}@example.com`,
        adminFirstName: 'Bella',
        adminLastName: 'Owner',
      });

    expect(res.status).toBe(201);
    expect(provisioningStub.provisionTenantForLead).toHaveBeenCalledTimes(1);

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.status).toBe('WON');
    expect(lead.convertedTenantId).toBe(`tenant-${SEED}`);
    expect(lead.convertedAt).toBeTruthy();
    tenantId = lead.convertedTenantId!;
  });

  it('4) a SIGNUP commission materializes for the assigned rep from the plan facts', async () => {
    const commission = await prisma.commission.findFirstOrThrow({
      where: { workspaceId, leadId },
    });
    expect(commission.type).toBe('SIGNUP');
    expect(commission.status).toBe('PENDING');
    expect(commission.marketingUserId).toBe(repId);
    expect(commission.tenantId).toBe(tenantId);
    // 100 (monthlyPrice) × 0.1 (commissionRate) = 10.00
    expect(Number(commission.amount)).toBeCloseTo(10);
  });

  it('5) the conversion emitted a durable LeadConverted outbox event in the same commit', async () => {
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { idempotencyKey: `lead-converted:${leadId}` },
    });
    expect(event.type).toContain('lead');
    const payload = event.payload as Record<string, unknown>;
    expect(payload.leadId).toBe(leadId);
    expect(payload.tenantId).toBe(tenantId);
  });
});
