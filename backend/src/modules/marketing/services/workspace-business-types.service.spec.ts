import { NotFoundException } from '@nestjs/common';
import { WorkspaceBusinessTypesService } from './workspace-business-types.service';

describe('WorkspaceBusinessTypesService', () => {
  const prisma = { workspace: { findUnique: jest.fn() }, lead: { groupBy: jest.fn() }, $queryRaw: jest.fn() };
  const service = new WorkspaceBusinessTypesService(prisma as any);
  beforeEach(() => { jest.resetAllMocks(); prisma.lead.groupBy.mockResolvedValue([]); });

  it.each([
    null,
    {},
    { businessTypes: null },
    { businessTypes: [] },
    { businessTypes: 'OTHER' },
    { businessTypes: ['', 'lower', null] },
  ])(
    'uses a generic fallback for unconfigured settings %j',
    async (settings) => {
      prisma.workspace.findUnique.mockResolvedValue({ settings });
      expect(await service.get('ws-own')).toEqual({ businessTypes: ['OTHER'] });
      expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
        where: { id: 'ws-own' },
        select: { settings: true },
      });
    },
  );

  it('retains valid legacy keys while removing malformed and duplicate values', async () => {
    prisma.workspace.findUnique.mockResolvedValue({
      settings: {
        businessTypes: [
          'legacy-value',
          '',
          'RESTAURANT',
          'CUSTOM',
          'CUSTOM',
          null,
          42,
          '_INVALID',
          'A'.repeat(61),
        ],
      },
    });
    expect(await service.get('ws-own')).toEqual({
      businessTypes: ['RESTAURANT', 'CUSTOM'],
    });
  });

  it('returns valid distinct historical lead keys independently of configured types', async () => {
    prisma.workspace.findUnique.mockResolvedValue({ settings: { businessTypes: ['NEW'] } });
    prisma.lead.groupBy.mockResolvedValue([
      { businessType: 'RETIRED' }, { businessType: 'RETIRED' },
      { businessType: 'NEW' }, { businessType: '' }, { businessType: 'invalid' },
      { businessType: null },
    ]);
    expect(await service.get('ws-own')).toEqual({
      businessTypes: ['NEW'], historicalBusinessTypes: ['RETIRED', 'NEW'],
    });
    expect(prisma.lead.groupBy).toHaveBeenCalledWith({
      where: { workspaceId: 'ws-own' }, by: ['businessType'],
    });
  });

  it('does not treat a missing workspace as unconfigured', async () => {
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(service.get('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(service.set('missing', ['OTHER'])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('returns the persisted list and binds the workspace and JSON as SQL parameters', async () => {
    prisma.$queryRaw.mockResolvedValue([{ businessTypes: ['CUSTOM'] }]);
    expect(await service.set('ws-own', ['CUSTOM'])).toEqual({
      businessTypes: ['CUSTOM'],
    });
    const [sql, ...params] = prisma.$queryRaw.mock.calls[0];
    expect(params).toEqual(['["CUSTOM"]', 'ws-own']);
    expect(sql.join('?')).toMatch(/jsonb_set/);
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled();
  });
});
