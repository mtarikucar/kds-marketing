import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PrismaService } from '../../../prisma/prisma.service';
import { AUDIT_METADATA } from '../../audit/audit.decorator';
import { MediaModelDefaultsService } from '../ai/media/media-model-defaults.service';
import { RolesService } from '../roles/roles.service';
import { MarketingAuthService } from '../services/marketing-auth.service';
import { WorkspaceBusinessTypesService } from '../services/workspace-business-types.service';
import { MarketingWorkspacesController } from './marketing-workspaces.controller';

describe('Workspace business types HTTP', () => {
  let app: INestApplication;
  const jwt = new JwtService({ secret: 'business-types-test-secret' });
  const prisma = {
    marketingUser: { findUnique: jest.fn() },
    workspace: { findUnique: jest.fn() },
    lead: { groupBy: jest.fn() },
    customRole: { findFirst: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const token = () =>
    jwt.sign({ sub: 'user-1', wsp: 'ws-active', type: 'marketing' });
  const principal = (role = 'REP', customRoleId: string | null = null) => {
    prisma.marketingUser.findUnique.mockResolvedValue({
      id: 'user-1',
      workspaceId: 'ws-home',
      role: 'OWNER',
      status: 'ACTIVE',
      memberships: [{ workspaceId: 'ws-active', role, customRoleId }],
    });
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [MarketingWorkspacesController],
      providers: [
        WorkspaceBusinessTypesService,
        RolesService,
        { provide: MarketingAuthService, useValue: {} },
        { provide: MediaModelDefaultsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
        {
          provide: ConfigService,
          useValue: new ConfigService({
            MARKETING_JWT_SECRET: 'business-types-test-secret',
          }),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    jest.resetAllMocks();
    prisma.lead.groupBy.mockResolvedValue([]);
    principal();
  });
  const path = '/marketing/workspaces/business-types';

  it('requires authentication for both routes', async () => {
    await request(app.getHttpServer()).get(path).expect(401);
    await request(app.getHttpServer())
      .patch(path)
      .send({ businessTypes: ['OTHER'] })
      .expect(401);
  });

  it('allows REP reads from the active workspace, without settings permission', async () => {
    principal('REP', 'restricted');
    prisma.workspace.findUnique.mockResolvedValue({ settings: null });
    await request(app.getHttpServer())
      .get(path)
      .auth(token(), { type: 'bearer' })
      .expect(200, { businessTypes: ['OTHER'], canManage: false });
    expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: 'ws-active' },
      select: { settings: true },
    });
  });

  it('reports effective settings permission for the editor', async () => {
    principal('MANAGER', 'restricted');
    prisma.workspace.findUnique.mockResolvedValue({ settings: null });
    prisma.customRole.findFirst.mockResolvedValue({ permissions: ['leads.read'] });
    await request(app.getHttpServer()).get(path).auth(token(), { type: 'bearer' })
      .expect(200, { businessTypes: ['OTHER'], canManage: false });
    principal('OWNER');
    await request(app.getHttpServer()).get(path).auth(token(), { type: 'bearer' })
      .expect(200, { businessTypes: ['OTHER'], canManage: true });
  });

  it('denies REP writes and MANAGER writes lacking settings.manage', async () => {
    await request(app.getHttpServer())
      .patch(path)
      .auth(token(), { type: 'bearer' })
      .send({ businessTypes: ['OTHER'] })
      .expect(403);
    principal('MANAGER', 'restricted');
    prisma.customRole.findFirst.mockResolvedValue({
      permissions: ['leads.read'],
    });
    await request(app.getHttpServer())
      .patch(path)
      .auth(token(), { type: 'bearer' })
      .send({ businessTypes: ['OTHER'] })
      .expect(403);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it.each(['MANAGER', 'OWNER'])(
    'allows %s to update only their active workspace',
    async (role) => {
      principal(role);
      prisma.$queryRaw.mockResolvedValue([{ businessTypes: ['NEW_TYPE'] }]);
      await request(app.getHttpServer())
        .patch(path)
        .auth(token(), { type: 'bearer' })
        .send({ businessTypes: ['NEW_TYPE'] })
        .expect(200, { businessTypes: ['NEW_TYPE'] });
      expect(prisma.$queryRaw.mock.calls[0].slice(1)).toEqual([
        '["NEW_TYPE"]',
        'ws-active',
      ]);
    },
  );

  it.each([
    { businessTypes: [] },
    { businessTypes: ['A', 'A'] },
    { businessTypes: ['lower'] },
    { businessTypes: ['OTHER'], workspaceId: 'ws-victim' },
  ])('rejects invalid or workspace-spoofing payload %j', async (body) => {
    principal('MANAGER');
    await request(app.getHttpServer())
      .patch(path)
      .auth(token(), { type: 'bearer' })
      .send(body)
      .expect(400);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('declares the settings write audit with captured business types', () => {
    expect(
      Reflect.getMetadata(
        AUDIT_METADATA,
        MarketingWorkspacesController.prototype.setWorkspaceBusinessTypes,
      ),
    ).toEqual({
      action: 'workspace.business_types.update',
      resourceType: 'workspace',
      captureBody: ['businessTypes'],
    });
  });
});
