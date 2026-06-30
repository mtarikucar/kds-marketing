import { BadRequestException } from '@nestjs/common';
import { SegmentCompilerService } from './segment-compiler.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  const svc = new SegmentCompilerService(prisma as any);
  return { prisma, svc };
}

describe('SegmentCompilerService.compile', () => {
  let svc: SegmentCompilerService;
  beforeEach(() => {
    ({ svc } = makeSvc());
  });

  it('pins workspaceId and compiles a single native eq leaf', () => {
    const where = svc.compile(WS, { field: 'status', cmp: 'eq', value: 'NEW' });
    expect(where).toEqual({ AND: [{ workspaceId: WS }, { status: 'NEW' }] });
  });

  it('returns just the workspace pin for an empty group', () => {
    expect(svc.compile(WS, { op: 'and', children: [] })).toEqual({ workspaceId: WS });
  });

  it('maps and/or groups to Prisma AND/OR', () => {
    const where = svc.compile(WS, {
      op: 'or',
      children: [
        { field: 'source', cmp: 'eq', value: 'WEBSITE' },
        { field: 'aiScore', cmp: 'gte', value: 70 },
      ],
    });
    expect(where).toEqual({
      AND: [
        { workspaceId: WS },
        { OR: [{ source: 'WEBSITE' }, { aiScore: { gte: 70 } }] },
      ],
    });
  });

  it('compiles in / nin / contains', () => {
    expect(svc.compile(WS, { field: 'status', cmp: 'in', value: ['NEW', 'CONTACTED'] }))
      .toEqual({ AND: [{ workspaceId: WS }, { status: { in: ['NEW', 'CONTACTED'] } }] });
    expect(svc.compile(WS, { field: 'city', cmp: 'contains', value: 'ist' }))
      .toEqual({ AND: [{ workspaceId: WS }, { city: { contains: 'ist', mode: 'insensitive' } }] });
  });

  it('coerces date fields to Date', () => {
    const where = svc.compile(WS, { field: 'createdAt', cmp: 'gte', value: '2026-01-01' });
    expect(where).toEqual({
      AND: [{ workspaceId: WS }, { createdAt: { gte: new Date('2026-01-01') } }],
    });
  });

  it('compiles isSet / isNotSet on native fields', () => {
    expect(svc.compile(WS, { field: 'nextFollowUp', cmp: 'isSet' }))
      .toEqual({ AND: [{ workspaceId: WS }, { nextFollowUp: { not: null } }] });
    expect(svc.compile(WS, { field: 'email', cmp: 'isNotSet' }))
      .toEqual({ AND: [{ workspaceId: WS }, { email: null }] });
  });

  it('compiles a custom field via JSON path', () => {
    expect(svc.compile(WS, { field: 'cf:budget', cmp: 'gte', value: 1000 }))
      .toEqual({ AND: [{ workspaceId: WS }, { customFields: { path: ['budget'], gte: 1000 } }] });
    expect(svc.compile(WS, { field: 'cf:tier', cmp: 'eq', value: 'gold' }))
      .toEqual({ AND: [{ workspaceId: WS }, { customFields: { path: ['tier'], equals: 'gold' } }] });
  });

  it('compiles tag membership', () => {
    expect(svc.compile(WS, { field: 'tag', cmp: 'has', value: 't1' }))
      .toEqual({ AND: [{ workspaceId: WS }, { tags: { some: { tagId: 't1' } } }] });
    expect(svc.compile(WS, { field: 'tag', cmp: 'hasNot', value: 't1' }))
      .toEqual({ AND: [{ workspaceId: WS }, { tags: { none: { tagId: 't1' } } }] });
  });

  it('compiles between on a number field', () => {
    expect(svc.compile(WS, { field: 'aiScore', cmp: 'between', value: [40, 80] }))
      .toEqual({ AND: [{ workspaceId: WS }, { aiScore: { gte: 40, lte: 80 } }] });
  });
});

describe('SegmentCompilerService.validate', () => {
  let prisma: MockPrismaClient;
  let svc: SegmentCompilerService;
  beforeEach(() => {
    ({ prisma, svc } = makeSvc());
    prisma.customFieldDef.findMany.mockResolvedValue([{ key: 'budget' }] as any);
  });

  it('accepts a valid tree', async () => {
    await expect(
      svc.validate(WS, {
        op: 'and',
        children: [
          { field: 'status', cmp: 'in', value: ['NEW'] },
          { field: 'cf:budget', cmp: 'gte', value: 1000 },
          { field: 'tag', cmp: 'has', value: 't1' },
        ],
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects an unknown native field', async () => {
    await expect(svc.validate(WS, { field: 'bogus', cmp: 'eq', value: 1 }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a comparator not allowed for the field type', async () => {
    await expect(svc.validate(WS, { field: 'emailOptOut', cmp: 'contains', value: 'x' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a custom field that has no definition', async () => {
    await expect(svc.validate(WS, { field: 'cf:ghost', cmp: 'eq', value: 1 }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a tree that is too deep', async () => {
    let node: any = { field: 'status', cmp: 'eq', value: 'NEW' };
    for (let i = 0; i < 8; i++) node = { op: 'and', children: [node] };
    await expect(svc.validate(WS, node)).rejects.toBeInstanceOf(BadRequestException);
  });

  // A non-string value on a string column compiles into a Prisma filter that
  // throws on every evaluation — reject it at save time (like number/date).
  it('rejects a non-string value on a string field', async () => {
    await expect(
      svc.validate(WS, { field: 'businessName', cmp: 'contains', value: { evil: true } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-string element in an in[] on a string field', async () => {
    await expect(
      svc.validate(WS, { field: 'status', cmp: 'in', value: ['NEW', 123] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still accepts proper string values', async () => {
    await expect(
      svc.validate(WS, { field: 'businessName', cmp: 'contains', value: 'acme' }),
    ).resolves.toBeUndefined();
  });

  // A SCALAR comparator (eq/ne/gt/gte/lt/lte/contains/startsWith) with an ARRAY
  // value compiles to an invalid Prisma filter — `{ status: ['a','b'] }` — that
  // throws on EVERY later evaluation (member count / audience / campaign send).
  // The predicate builder can leave a stale array when the operator is switched
  // from in/nin → eq, and the raw-JSON editor can send one directly. Reject at
  // save time so a segment can't be persisted in a 500-on-evaluation state.
  it('rejects an array value on a string scalar comparator (eq)', async () => {
    await expect(
      svc.validate(WS, { field: 'status', cmp: 'eq', value: ['NEW', 'CONTACTED'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an array value on a numeric scalar comparator (gte)', async () => {
    await expect(
      svc.validate(WS, { field: 'aiScore', cmp: 'gte', value: [10, 20] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // A LIST comparator (in/nin) with a scalar value compiles to `{ in: [] }`
  // (matches nothing) silently — require the array at save time.
  it('rejects a non-array value on a list comparator (in)', async () => {
    await expect(
      svc.validate(WS, { field: 'status', cmp: 'in', value: 'NEW' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still accepts a scalar eq and a list in together', async () => {
    await expect(
      svc.validate(WS, {
        op: 'and',
        children: [
          { field: 'status', cmp: 'eq', value: 'NEW' },
          { field: 'status', cmp: 'in', value: ['NEW', 'CONTACTED'] },
        ],
      }),
    ).resolves.toBeUndefined();
  });
});
