import { NotFoundException, ConflictException } from '@nestjs/common';
import { SnippetsService } from './snippets.service';

const WS = 'ws-1';
const ME = 'user-1';

function makePrisma() {
  return {
    messageSnippet: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 's1' }),
      update: jest.fn().mockResolvedValue({ id: 's1' }),
      delete: jest.fn().mockResolvedValue({}),
    },
  };
}

describe('SnippetsService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let svc: SnippetsService;

  beforeEach(() => {
    prisma = makePrisma();
    svc = new SnippetsService(prisma as any);
  });

  it('list returns shared + own (not other agents private)', async () => {
    prisma.messageSnippet.findMany.mockResolvedValue([]);
    await svc.list(WS, ME);
    const where = prisma.messageSnippet.findMany.mock.calls[0][0].where;
    expect(where.workspaceId).toBe(WS);
    expect(where.OR).toEqual([{ ownerId: null }, { ownerId: ME }]);
  });

  it('create rejects a duplicate shortcut', async () => {
    prisma.messageSnippet.findUnique.mockResolvedValue({ id: 'x' });
    await expect(
      svc.create(WS, ME, { shortcut: 'greeting', title: 'Hi', body: 'Hello' } as any),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('create stores ownerId null when shared, else the author', async () => {
    prisma.messageSnippet.findUnique.mockResolvedValue(null);
    await svc.create(WS, ME, { shortcut: 'g', title: 'T', body: 'B', shared: true } as any);
    expect(prisma.messageSnippet.create.mock.calls[0][0].data.ownerId).toBeNull();

    await svc.create(WS, ME, { shortcut: 'p', title: 'T', body: 'B' } as any);
    expect(prisma.messageSnippet.create.mock.calls[1][0].data.ownerId).toBe(ME);
  });

  it('update refuses another agent private snippet', async () => {
    prisma.messageSnippet.findFirst.mockResolvedValue({ id: 's1', workspaceId: WS, ownerId: 'someone-else' });
    await expect(svc.update(WS, ME, 's1', { title: 'x' } as any)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update allows a shared snippet (ownerId null)', async () => {
    prisma.messageSnippet.findFirst.mockResolvedValue({ id: 's1', workspaceId: WS, ownerId: null });
    await svc.update(WS, ME, 's1', { title: 'x' } as any);
    expect(prisma.messageSnippet.update).toHaveBeenCalled();
  });
});
