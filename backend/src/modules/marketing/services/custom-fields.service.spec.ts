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

  it('grandfathers a stale SELECT value on UPDATE (removing an option must not brick editing affected records)', async () => {
    // The edit form resubmits the FULL field map, so a value that WAS valid when
    // saved but whose option was later removed would otherwise fail coercion and
    // block the whole lead save. On update the stored value is kept; create stays strict.
    expect(await svc.validateAndNormalize(WS, 'LEAD', { tier: 'platinum' }, 'update'))
      .toEqual({ tier: 'platinum' });
  });

  it('grandfathers stale MULTISELECT values on UPDATE but still requires an array', async () => {
    prisma.customFieldDef.findMany.mockResolvedValue([
      { id: 'm1', workspaceId: WS, entity: 'LEAD', key: 'labels', type: 'MULTISELECT', options: [{ value: 'a' }], required: false, archived: false },
    ] as any);
    // 'b' (option since removed) is kept on update instead of bricking the save…
    expect(await svc.validateAndNormalize(WS, 'LEAD', { labels: ['a', 'b'] }, 'update'))
      .toEqual({ labels: ['a', 'b'] });
    // …but a non-array is malformed regardless of mode.
    await expect(svc.validateAndNormalize(WS, 'LEAD', { labels: 'nope' }, 'update'))
      .rejects.toBeInstanceOf(BadRequestException);
    // create still enforces the option membership.
    await expect(svc.validateAndNormalize(WS, 'LEAD', { labels: ['b'] }, 'create'))
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

  // Default: an empty value is SKIPPED so a blank import cell / omitted field
  // can't clobber the stored value (import even calls with mode='update').
  it('skips empty values by default (blank does not clobber)', async () => {
    expect(await svc.validateAndNormalize(WS, 'LEAD', { budget: '', signed: '' }, 'update')).toEqual({});
  });

  // Edit forms send the FULL field map and opt into clearEmpty: an explicitly
  // emptied field becomes null so the caller's {...existing, ...partial} merge
  // actually CLEARS it (previously the old value silently persisted).
  it('with clearEmpty, maps an explicitly-emptied field to null', async () => {
    const out = await svc.validateAndNormalize(
      WS, 'LEAD', { budget: '', tier: 'gold' }, 'update', { clearEmpty: true },
    );
    expect(out).toEqual({ budget: null, tier: 'gold' });
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

  // The dup pre-check is a TOCTOU window: two concurrent creates of the same key
  // both pass findUnique, the 2nd insert trips the (workspaceId, entity, key)
  // unique → P2002. Without a catch that bubbles as a raw 500; map it to a clean
  // 409 like tags.create / snippets.create do (no global P2002→409 mapping).
  it('maps a P2002 race on create to a 409 (concurrent same-key insert)', async () => {
    prisma.customFieldDef.findUnique.mockResolvedValue(null); // pre-check passes
    (prisma.customFieldDef.create as jest.Mock).mockRejectedValue(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );
    await expect(svc.create(WS, { label: 'Annual Budget', type: 'NUMBER' } as any))
      .rejects.toBeInstanceOf(ConflictException);
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
