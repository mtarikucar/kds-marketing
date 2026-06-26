import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { CustomFieldsService } from './custom-fields.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';
const defs = [
  { id: 'd1', workspaceId: WS, entity: 'LEAD', key: 'budget', type: 'NUMBER', options: null, required: false, archived: false },
  { id: 'd2', workspaceId: WS, entity: 'LEAD', key: 'tier', type: 'SELECT', options: [{ value: 'gold', label: 'Gold' }], required: true, archived: false },
  { id: 'd3', workspaceId: WS, entity: 'LEAD', key: 'signed', type: 'BOOL', options: null, required: false, archived: false },
];

function makeSvc() {
  const prisma = mockPrismaClient();
  const svc = new CustomFieldsService(prisma as any, { append: jest.fn() } as any);
  return { prisma, svc };
}

describe('CustomFieldsService.validateAndNormalize', () => {
  let prisma: MockPrismaClient;
  let svc: CustomFieldsService;
  beforeEach(() => {
    ({ prisma, svc } = makeSvc());
    prisma.customFieldDef.findMany.mockResolvedValue(defs as any);
  });

  it('coerces NUMBER + BOOL and passes through a valid SELECT', async () => {
    const out = await svc.validateAndNormalize(WS, 'LEAD', { budget: '1500', tier: 'gold', signed: 'true' }, 'create');
    expect(out).toEqual({ budget: 1500, tier: 'gold', signed: true });
  });

  it('rejects a SELECT value not in options', async () => {
    await expect(svc.validateAndNormalize(WS, 'LEAD', { tier: 'platinum' }, 'create'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-numeric NUMBER', async () => {
    await expect(svc.validateAndNormalize(WS, 'LEAD', { budget: 'abc', tier: 'gold' }, 'create'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('enforces required on create, but not on update', async () => {
    await expect(svc.validateAndNormalize(WS, 'LEAD', { budget: 10 }, 'create'))
      .rejects.toBeInstanceOf(BadRequestException); // tier missing
    await expect(svc.validateAndNormalize(WS, 'LEAD', { budget: 10 }, 'update'))
      .resolves.toEqual({ budget: 10 });
  });

  it('drops unknown keys', async () => {
    const out = await svc.validateAndNormalize(WS, 'LEAD', { tier: 'gold', bogus: 'x' }, 'create');
    expect(out).toEqual({ tier: 'gold' });
  });

  it('returns {} for empty/undefined input on update', async () => {
    expect(await svc.validateAndNormalize(WS, 'LEAD', undefined, 'update')).toEqual({});
    expect(await svc.validateAndNormalize(WS, 'LEAD', {}, 'update')).toEqual({});
  });
});

describe('CustomFieldsService def CRUD', () => {
  let prisma: MockPrismaClient;
  let svc: CustomFieldsService;
  beforeEach(() => {
    ({ prisma, svc } = makeSvc());
  });

  it('derives a snake_case key from the label and rejects duplicates', async () => {
    prisma.customFieldDef.findUnique.mockResolvedValue(null);
    (prisma.customFieldDef.create as jest.Mock).mockImplementation((args: any) =>
      Promise.resolve({ id: 'new', ...args.data }),
    );
    const created: any = await svc.create(WS, { label: 'Annual Budget', type: 'NUMBER' } as any);
    expect(created.key).toBe('annual_budget');

    prisma.customFieldDef.findUnique.mockResolvedValue({ id: 'd1' } as any);
    await expect(svc.create(WS, { label: 'Annual Budget', type: 'NUMBER' } as any))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('requires options for SELECT/MULTISELECT', async () => {
    prisma.customFieldDef.findUnique.mockResolvedValue(null);
    await expect(svc.create(WS, { label: 'Tier', type: 'SELECT' } as any))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects clearing the options of a SELECT field on update (would brick it)', async () => {
    // coerce() rejects every value against an empty option list, so a SELECT
    // left optionless can never be set again — update must guard it like create.
    prisma.customFieldDef.findFirst.mockResolvedValue({
      id: 'd2', workspaceId: WS, entity: 'LEAD', key: 'tier', type: 'SELECT',
      options: [{ value: 'gold' }], required: true, archived: false,
    } as any);
    await expect(svc.update(WS, 'd2', { options: [] } as any))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows a non-SELECT field update that carries no options', async () => {
    prisma.customFieldDef.findFirst.mockResolvedValue({
      id: 'd1', workspaceId: WS, entity: 'LEAD', key: 'budget', type: 'NUMBER',
      options: null, required: false, archived: false,
    } as any);
    (prisma.customFieldDef.update as jest.Mock).mockResolvedValue({ id: 'd1', label: 'Budget' });
    await expect(svc.update(WS, 'd1', { label: 'Budget' } as any)).resolves.toBeDefined();
  });

  it('archive throws NotFound when the def is not in the workspace', async () => {
    prisma.customFieldDef.findFirst.mockResolvedValue(null);
    await expect(svc.archive(WS, 'nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});
