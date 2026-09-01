import { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MarketingContentDistributionController } from './marketing-content-distribution.controller';
import { ContentDistributionService } from '../distribution/content-distribution.service';
import { DistributionSendService } from '../distribution/distribution-send.service';
import { MarketingGuard } from '../guards/marketing.guard';
import { FeatureGuard } from '../guards/feature.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { PermissionsGuard } from '../roles/permissions.guard';
import { RolesService } from '../roles/roles.service';
import { PrismaService } from '../../../prisma/prisma.service';

/**
 * The human door onto the distribution plan, with the REAL guard stack.
 *
 * The assertion that matters is not "the route exists" — it is that the ACTOR
 * the send is attributed to comes from the authenticated principal and can not
 * be supplied by the caller. A send route that read an actor id out of the body
 * would satisfy every other test in this feature and destroy the boundary the
 * whole stage exists to build.
 */
class FakeMarketingGuard implements CanActivate {
  constructor(private readonly user: Record<string, unknown>) {}
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest().marketingUser = this.user;
    return true;
  }
}

async function buildApp(
  role: string,
  deps: { distribution?: Record<string, jest.Mock>; sender?: Record<string, jest.Mock> } = {},
  opts: { customRoleId?: string | null; prisma?: Record<string, unknown> } = {},
): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [MarketingContentDistributionController],
    providers: [
      { provide: ContentDistributionService, useValue: deps.distribution ?? {} },
      { provide: DistributionSendService, useValue: deps.sender ?? {} },
      // The REAL role/permission guards — the point of this block.
      MarketingRolesGuard,
      PermissionsGuard,
      RolesService,
      { provide: PrismaService, useValue: opts.prisma ?? {} },
    ],
  })
    .overrideGuard(MarketingGuard)
    .useValue(
      new FakeMarketingGuard({
        id: 'human-1',
        workspaceId: 'ws-1',
        role,
        email: 'a@test.local',
        customRoleId: opts.customRoleId ?? null,
      }),
    )
    // Entitlements are a different question, answered by its own suite.
    .overrideGuard(FeatureGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('MarketingContentDistributionController', () => {
  it('attributes the send to the AUTHENTICATED person, never to the body', async () => {
    const sender = { send: jest.fn().mockResolvedValue({ draftId: 'd1', conversationId: 'c1' }) };
    const app = await buildApp('MANAGER', { sender });
    try {
      const res = await request(app.getHttpServer())
        .post('/marketing/content-distribution/drafts/d1/send')
        // A caller trying to send AS somebody else. The field is not in the DTO
        // and is not read; the actor below is the principal's id.
        .send({ text: 'hello', actorId: 'somebody-else', userId: 'somebody-else' });

      expect(res.status).toBe(201);
      expect(sender.send).toHaveBeenCalledWith('ws-1', 'd1', 'human-1', 'hello');
    } finally {
      await app.close();
    }
  });

  it('refuses a REP: sending is MANAGER + leads.write, like conversations/start', async () => {
    const sender = { send: jest.fn() };
    const app = await buildApp('REP', { sender });
    try {
      const res = await request(app.getHttpServer())
        .post('/marketing/content-distribution/drafts/d1/send')
        .send({});
      expect(res.status).toBe(403);
      expect(sender.send).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('refuses a MANAGER-rank custom role that lacks leads.write', async () => {
    const sender = { send: jest.fn() };
    const prisma = {
      customRole: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'cr-1',
          workspaceId: 'ws-1',
          permissions: ['campaigns.write'], // may plan, may not send
        }),
      },
    };
    const app = await buildApp('MANAGER', { sender }, { customRoleId: 'cr-1', prisma });
    try {
      const res = await request(app.getHttpServer())
        .post('/marketing/content-distribution/drafts/d1/send')
        .send({});
      expect(res.status).toBe(403);
      expect(sender.send).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('lets that same custom role PRODUCE a plan — planning is inert, sending is not', async () => {
    const distribution = { plan: jest.fn().mockResolvedValue({ id: 'plan-1' }) };
    const prisma = {
      customRole: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'cr-1',
          workspaceId: 'ws-1',
          permissions: ['campaigns.write'],
        }),
      },
    };
    const app = await buildApp('MANAGER', { distribution }, { customRoleId: 'cr-1', prisma });
    try {
      const res = await request(app.getHttpServer()).post(
        '/marketing/content-distribution/item-1/plan',
      );
      expect(res.status).toBe(201);
      expect(distribution.plan).toHaveBeenCalledWith('ws-1', 'item-1', 'human-1');
    } finally {
      await app.close();
    }
  });

  /** `drafts` is declared before `:campaignItemId`, so the literal wins — this
   *  is the assertion that says so rather than the comment claiming it. */
  it('routes /drafts to the draft list, not to the plan-by-item read', async () => {
    const distribution = { listDrafts: jest.fn().mockResolvedValue([]), get: jest.fn() };
    const app = await buildApp('MANAGER', { distribution });
    try {
      const res = await request(app.getHttpServer()).get(
        '/marketing/content-distribution/drafts?status=DRAFT',
      );
      expect(res.status).toBe(200);
      expect(distribution.listDrafts).toHaveBeenCalledWith('ws-1', { status: 'DRAFT' });
      expect(distribution.get).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
