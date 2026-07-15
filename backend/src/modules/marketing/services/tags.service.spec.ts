import { ConflictException, NotFoundException } from '@nestjs/common';
import { TagsService } from './tags.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  const outbox = { append: jest.fn().mockResolvedValue('ob-1') };
  const svc = new TagsService(prisma as any, outbox as any);
  return { prisma, outbox, svc };
}

describe('TagsService.create', () => {
  it('normalizes the name and rejects a case-insensitive duplicate', async () => {
    const { prisma, svc } = makeSvc();
    prisma.tag.findUnique.mockResolvedValue(null as any);
    (prisma.tag.create as jest.Mock).mockImplementation((args: any) =>
      Promise.resolve({ id: 't1', ...args.data }),
    );
    const created: any = await svc.create(WS, { name: '  VIP  ' });
    expect(created).toMatchObject({ name: 'VIP', nameLower: 'vip' });

    prisma.tag.findUnique.mockResolvedValue({ id: 't1' } as any);
    await expect(svc.create(WS, { name: 'vip' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a raced unique violation (P2002) to a clean Conflict, not a 500', async () => {
    const { prisma, svc } = makeSvc();
    prisma.tag.findUnique.mockResolvedValue(null as any); // passes the pre-check
    (prisma.tag.create as jest.Mock).mockRejectedValue({ code: 'P2002' }); // concurrent create wins
    await expect(svc.create(WS, { name: 'vip' })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('TagsService.update', () => {
  it('rejects a rename to a name another tag already holds (pre-check)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.tag.findFirst.mockResolvedValue({ id: 't1', workspaceId: WS, name: 'old', nameLower: 'old' } as any);
    prisma.tag.findUnique.mockResolvedValue({ id: 't2' } as any); // a DIFFERENT tag holds the target name
    await expect(svc.update(WS, 't1', { name: 'VIP' })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.tag.update).not.toHaveBeenCalled();
  });

  // The pre-check is racy; a concurrent rename to the same name trips the
  // (workspaceId, nameLower) unique AFTER the check passes. That must be a clean
  // 409 like create() — not a raw P2002 → 500.
  it('maps a raced unique violation (P2002) on rename to a clean Conflict, not a 500', async () => {
    const { prisma, svc } = makeSvc();
    prisma.tag.findFirst.mockResolvedValue({ id: 't1', workspaceId: WS, name: 'old', nameLower: 'old' } as any);
    prisma.tag.findUnique.mockResolvedValue(null as any); // pre-check passes (race window)
    (prisma.tag.update as jest.Mock).mockRejectedValue({ code: 'P2002' }); // concurrent rename wins
    await expect(svc.update(WS, 't1', { name: 'VIP' })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('TagsService.resolveOrCreate (concurrency)', () => {
  it('returns the winner when a concurrent create loses the unique race (P2002)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.tag.findUnique
      .mockResolvedValueOnce(null as any) // initial: not found → attempt create
      .mockResolvedValueOnce({ id: 't9', name: 'VIP' } as any); // re-query finds the winner
    (prisma.tag.create as jest.Mock).mockRejectedValue({ code: 'P2002' });

    const out = await svc.resolveOrCreate(WS, ['VIP']);
    expect(out).toEqual([{ id: 't9', name: 'VIP' }]);
  });
});

describe('TagsService.assignToLead', () => {
  it('auto-creates unknown tags, links only the new ones, and emits tag.added', async () => {
    const { prisma, outbox, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    prisma.tag.findUnique.mockResolvedValue(null as any); // unknown → create
    (prisma.tag.create as jest.Mock).mockResolvedValue({ id: 't1', name: 'vip' } as any);
    prisma.leadTag.findMany
      .mockResolvedValueOnce([] as any) // existing-link check: none
      .mockResolvedValueOnce([{ tag: { id: 't1', name: 'vip' } }] as any); // final list
    (prisma.leadTag.createMany as jest.Mock).mockResolvedValue({ count: 1 });

    const out: any = await svc.assignToLead(WS, 'lead-1', ['vip'], 'u1');

    expect(prisma.leadTag.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [{ leadId: 'lead-1', tagId: 't1', assignedById: 'u1' }],
        skipDuplicates: true,
      }),
    );
    expect(outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'marketing.lead.tag.added.v1' }),
    );
    expect(out).toEqual([{ id: 't1', name: 'vip' }]);
  });

  it('is idempotent — an already-linked tag is not re-created and emits nothing', async () => {
    const { prisma, outbox, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    prisma.tag.findUnique.mockResolvedValue({ id: 't1', name: 'vip' } as any);
    prisma.leadTag.findMany
      .mockResolvedValueOnce([{ tagId: 't1' }] as any) // already linked
      .mockResolvedValueOnce([{ tag: { id: 't1', name: 'vip' } }] as any);

    await svc.assignToLead(WS, 'lead-1', ['vip']);

    expect(prisma.leadTag.createMany).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });

  it('throws NotFound when the lead is not in the workspace', async () => {
    const { prisma, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue(null as any);
    await expect(svc.assignToLead(WS, 'ghost', ['vip'])).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('TagsService.unassignFromLead', () => {
  it('deletes the links and emits tag.removed when something was removed', async () => {
    const { prisma, outbox, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.leadTag.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    const res: any = await svc.unassignFromLead(WS, 'lead-1', ['t1']);

    expect(res).toEqual({ removed: 1 });
    expect(outbox.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'marketing.lead.tag.removed.v1' }),
    );
  });

  it('emits nothing when no link matched', async () => {
    const { prisma, outbox, svc } = makeSvc();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' } as any);
    (prisma.leadTag.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    await svc.unassignFromLead(WS, 'lead-1', ['t1']);
    expect(outbox.append).not.toHaveBeenCalled();
  });
});

describe('TagsService.list', () => {
  it('returns tags with member counts', async () => {
    const { prisma, svc } = makeSvc();
    prisma.tag.findMany.mockResolvedValue([
      { id: 't1', workspaceId: WS, name: 'vip', color: null, createdAt: new Date(), _count: { leadTags: 3 } },
    ] as any);
    const out: any = await svc.list(WS);
    expect(out[0]).toMatchObject({ id: 't1', name: 'vip', count: 3 });
  });
});

describe('TagsService.remove — segment-reference guard', () => {
  it('refuses (409) to delete a tag a segment still references, and does NOT delete', async () => {
    const { prisma, svc } = makeSvc();
    prisma.tag.findFirst.mockResolvedValue({ id: 't1', workspaceId: WS } as any);
    // A "leads WITHOUT tag t1" segment — deleting t1 would explode it to the
    // whole workspace, so the delete must be blocked.
    prisma.segment.findMany.mockResolvedValue([
      { name: 'No-VIP', definition: { op: 'and', children: [{ field: 'tag', cmp: 'hasNot', value: 't1' }] } },
    ] as any);
    await expect(svc.remove(WS, 't1')).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.remove(WS, 't1')).rejects.toThrow(/No-VIP/);
    expect(prisma.tag.delete).not.toHaveBeenCalled();
  });

  it('deletes when no segment references the tag (a segment on a DIFFERENT tag is fine)', async () => {
    const { prisma, svc } = makeSvc();
    prisma.tag.findFirst.mockResolvedValue({ id: 't1', workspaceId: WS } as any);
    prisma.segment.findMany.mockResolvedValue([
      { name: 'Other', definition: { op: 'or', children: [{ field: 'tag', cmp: 'has', value: 't-other' }, { field: 'city', cmp: 'eq', value: 'Izmir' }] } },
    ] as any);
    (prisma.tag.delete as jest.Mock).mockResolvedValue({ id: 't1' } as any);
    const res: any = await svc.remove(WS, 't1');
    expect(prisma.tag.delete).toHaveBeenCalledWith({ where: { id: 't1' } });
    expect(res).toEqual({ id: 't1' });
  });
});

describe('TagsService.bulkAssign — emits tag.added for the real delta', () => {
  it('links only the not-yet-linked leads and emits tag.added per newly-tagged lead', async () => {
    const { prisma, outbox, svc } = makeSvc();
    prisma.tag.findUnique.mockResolvedValue({ id: 't1', name: 'vip' } as any); // resolveOrCreate
    prisma.lead.findMany.mockResolvedValue([{ id: 'l1' }, { id: 'l2' }] as any);
    // l1 already carries t1; only l2 is a new link → only l2 gets an event.
    prisma.leadTag.findMany.mockResolvedValue([{ leadId: 'l1', tagId: 't1' }] as any);
    (prisma.leadTag.createMany as jest.Mock).mockResolvedValue({ count: 1 });

    const out: any = await svc.bulkAssign(WS, ['l1', 'l2'], ['vip'], 'u1');

    expect(prisma.leadTag.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [{ leadId: 'l2', tagId: 't1', assignedById: 'u1' }],
        skipDuplicates: true,
      }),
    );
    // Exactly one event — for l2, the only real addition.
    const added = outbox.append.mock.calls.filter((c: any[]) => c[0].type === 'marketing.lead.tag.added.v1');
    expect(added).toHaveLength(1);
    expect(added[0][0].payload).toMatchObject({ leadId: 'l2', workspaceId: WS, tagIds: ['t1'] });
    expect(out).toEqual({ leads: 2, tags: 1 });
  });

  it('emits nothing when every lead already carries the tag', async () => {
    const { prisma, outbox, svc } = makeSvc();
    prisma.tag.findUnique.mockResolvedValue({ id: 't1', name: 'vip' } as any);
    prisma.lead.findMany.mockResolvedValue([{ id: 'l1' }] as any);
    prisma.leadTag.findMany.mockResolvedValue([{ leadId: 'l1', tagId: 't1' }] as any);
    await svc.bulkAssign(WS, ['l1'], ['vip']);
    expect(prisma.leadTag.createMany).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
  });
});

describe('TagsService.bulkUnassign — emits tag.removed for real removals', () => {
  it('emits tag.removed only for leads that actually had the link', async () => {
    const { prisma, outbox, svc } = makeSvc();
    prisma.lead.findMany.mockResolvedValue([{ id: 'l1' }, { id: 'l2' }] as any);
    // Only l1 carries t1 before the delete.
    prisma.leadTag.findMany.mockResolvedValue([{ leadId: 'l1', tagId: 't1' }] as any);
    (prisma.leadTag.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

    const res: any = await svc.bulkUnassign(WS, ['l1', 'l2'], ['t1']);

    expect(res).toEqual({ removed: 1 });
    const removed = outbox.append.mock.calls.filter((c: any[]) => c[0].type === 'marketing.lead.tag.removed.v1');
    expect(removed).toHaveLength(1);
    expect(removed[0][0].payload).toMatchObject({ leadId: 'l1', workspaceId: WS, tagIds: ['t1'] });
  });

  it('emits nothing when no lead had a matching link', async () => {
    const { prisma, outbox, svc } = makeSvc();
    prisma.lead.findMany.mockResolvedValue([{ id: 'l1' }] as any);
    prisma.leadTag.findMany.mockResolvedValue([] as any);
    (prisma.leadTag.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    await svc.bulkUnassign(WS, ['l1'], ['t1']);
    expect(outbox.append).not.toHaveBeenCalled();
  });
});
