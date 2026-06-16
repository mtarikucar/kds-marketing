import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SegmentsService } from './segments.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

const WS = 'ws-1';

function makeSvc() {
  const prisma = mockPrismaClient();
  const compiler = {
    validate: jest.fn().mockResolvedValue(undefined),
    compile: jest.fn().mockReturnValue({ workspaceId: WS }),
  };
  const svc = new SegmentsService(prisma as any, compiler as any);
  return { prisma, compiler, svc };
}

describe('SegmentsService', () => {
  let prisma: MockPrismaClient;
  let compiler: { validate: jest.Mock; compile: jest.Mock };
  let svc: SegmentsService;
  beforeEach(() => {
    ({ prisma, compiler, svc } = makeSvc());
  });

  it('validates the definition before creating', async () => {
    (prisma.segment.create as jest.Mock).mockResolvedValue({ id: 's1' });
    const def = { field: 'status', cmp: 'eq', value: 'NEW' };
    await svc.create(WS, { name: 'New leads', definition: def });
    expect(compiler.validate).toHaveBeenCalledWith(WS, def);
    expect(prisma.segment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ workspaceId: WS, name: 'New leads', kind: 'DYNAMIC' }),
      }),
    );
  });

  it('propagates a validation error and does not persist', async () => {
    compiler.validate.mockRejectedValue(new BadRequestException('bad'));
    await expect(svc.create(WS, { name: 'X', definition: {} as any }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.segment.create).not.toHaveBeenCalled();
  });

  it('preview returns count + sample using the compiled where', async () => {
    (prisma.lead.count as jest.Mock).mockResolvedValue(3);
    (prisma.lead.findMany as jest.Mock).mockResolvedValue([{ id: 'l1' }]);
    const out = await svc.preview(WS, { field: 'status', cmp: 'eq', value: 'NEW' });
    expect(compiler.compile).toHaveBeenCalled();
    expect(out).toEqual({ count: 3, sample: [{ id: 'l1' }] });
  });

  it('count stamps lastCount + lastEvaluatedAt', async () => {
    prisma.segment.findFirst.mockResolvedValue({ id: 's1', definition: {} } as any);
    (prisma.lead.count as jest.Mock).mockResolvedValue(7);
    (prisma.segment.update as jest.Mock).mockResolvedValue({});
    const out = await svc.count(WS, 's1');
    expect(out).toEqual({ count: 7 });
    const arg = (prisma.segment.update as jest.Mock).mock.calls[0][0];
    expect(arg.data.lastCount).toBe(7);
    expect(arg.data.lastEvaluatedAt).toBeInstanceOf(Date);
  });

  it('members paginates', async () => {
    prisma.segment.findFirst.mockResolvedValue({ id: 's1', definition: {} } as any);
    (prisma.lead.findMany as jest.Mock).mockResolvedValue([{ id: 'l1' }]);
    (prisma.lead.count as jest.Mock).mockResolvedValue(1);
    const out = await svc.members(WS, 's1', 2, 25);
    expect(out).toEqual({ items: [{ id: 'l1' }], total: 1, page: 2, pageSize: 25 });
    const arg = (prisma.lead.findMany as jest.Mock).mock.calls[0][0];
    expect(arg.skip).toBe(25);
    expect(arg.take).toBe(25);
  });

  it('throws NotFound when updating a segment from another workspace', async () => {
    prisma.segment.findFirst.mockResolvedValue(null as any);
    await expect(svc.update(WS, 'ghost', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });
});
