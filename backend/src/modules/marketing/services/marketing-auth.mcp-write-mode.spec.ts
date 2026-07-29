import { BadRequestException } from '@nestjs/common';
import { MarketingAuthService } from './marketing-auth.service';

/**
 * MCP write-surface activation — the persistence half of the switch that lets
 * a workspace opt out of the human approval gate for MCP tool calls. The
 * controller (OWNER-only, @Audit-logged, DTO-validated) is the guarded front
 * door; these tests cover what actually lands in the database.
 */
describe('MarketingAuthService — mcp write mode', () => {
  let prisma: any;
  let svc: MarketingAuthService;

  beforeEach(() => {
    prisma = {
      workspace: {
        update: jest.fn(),
        findUnique: jest.fn(),
      },
    };
    svc = new MarketingAuthService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  describe('setMcpWriteMode', () => {
    it('persists AUTONOMOUS', async () => {
      prisma.workspace.update.mockResolvedValue({ mcpWriteMode: 'AUTONOMOUS' });

      const res = await svc.setMcpWriteMode('ws-1', 'AUTONOMOUS');

      expect(prisma.workspace.update).toHaveBeenCalledWith({
        where: { id: 'ws-1' },
        data: { mcpWriteMode: 'AUTONOMOUS' },
        select: { mcpWriteMode: true },
      });
      expect(res).toEqual({ mcpWriteMode: 'AUTONOMOUS' });
    });

    it('persists APPROVAL (re-arming the gate)', async () => {
      prisma.workspace.update.mockResolvedValue({ mcpWriteMode: 'APPROVAL' });

      const res = await svc.setMcpWriteMode('ws-1', 'APPROVAL');

      expect(prisma.workspace.update).toHaveBeenCalledWith({
        where: { id: 'ws-1' },
        data: { mcpWriteMode: 'APPROVAL' },
        select: { mcpWriteMode: true },
      });
      expect(res).toEqual({ mcpWriteMode: 'APPROVAL' });
    });

    it('scopes the write to the given workspace id, never a caller-supplied one', async () => {
      prisma.workspace.update.mockResolvedValue({ mcpWriteMode: 'AUTONOMOUS' });
      await svc.setMcpWriteMode('ws-caller-own', 'AUTONOMOUS');
      expect(prisma.workspace.update.mock.calls[0][0].where).toEqual({ id: 'ws-caller-own' });
    });
  });

  describe('getMcpWriteMode', () => {
    it('reads back the current value', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ mcpWriteMode: 'AUTONOMOUS' });
      const res = await svc.getMcpWriteMode('ws-1');
      expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
        where: { id: 'ws-1' },
        select: { mcpWriteMode: true },
      });
      expect(res).toEqual({ mcpWriteMode: 'AUTONOMOUS' });
    });

    it('defaults to APPROVAL shape when that is what is stored', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ mcpWriteMode: 'APPROVAL' });
      const res = await svc.getMcpWriteMode('ws-1');
      expect(res).toEqual({ mcpWriteMode: 'APPROVAL' });
    });

    it('throws if the workspace no longer exists', async () => {
      prisma.workspace.findUnique.mockResolvedValue(null);
      await expect(svc.getMcpWriteMode('ws-gone')).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
