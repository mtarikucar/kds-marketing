import { SystemSentinelService } from './system-sentinel';

/**
 * The author of every row the system writes on a tenant's behalf.
 *
 * The two things that must not happen: inventing an id (the FK on
 * `LeadActivity.createdById` is `Restrict`, so it would blow up at write time),
 * and caching the absence (a workspace provisioned after its first send would
 * then never get a trace again until the process restarted).
 */
describe('SystemSentinelService', () => {
  function build(rows: any[] = []) {
    const prisma: any = {
      marketingUser: {
        findFirst: jest.fn().mockImplementation(() => Promise.resolve(rows.shift() ?? null)),
      },
    };
    return { prisma, svc: new SystemSentinelService(prisma) };
  }

  it('resolves the workspace SYSTEM user, workspace-scoped', async () => {
    const { prisma, svc } = build([{ id: 'sys-1' }]);
    await expect(svc.resolve('ws-1')).resolves.toBe('sys-1');
    expect(prisma.marketingUser.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: 'ws-1', role: 'SYSTEM' } }),
    );
  });

  it('caches a resolved id', async () => {
    const { prisma, svc } = build([{ id: 'sys-1' }]);
    await svc.resolve('ws-1');
    await svc.resolve('ws-1');
    expect(prisma.marketingUser.findFirst).toHaveBeenCalledTimes(1);
  });

  it('never caches a miss — a later provisioning is picked up', async () => {
    const { prisma, svc } = build([null, { id: 'sys-late' }]);
    await expect(svc.resolve('ws-1')).resolves.toBeNull();
    await expect(svc.resolve('ws-1')).resolves.toBe('sys-late');
    expect(prisma.marketingUser.findFirst).toHaveBeenCalledTimes(2);
  });

  it('answers null instead of throwing when the read fails', async () => {
    const prisma: any = {
      marketingUser: { findFirst: jest.fn().mockRejectedValue(new Error('db down')) },
    };
    await expect(new SystemSentinelService(prisma).resolve('ws-1')).resolves.toBeNull();
  });

  it('answers null for a missing workspace id without touching the database', async () => {
    const { prisma, svc } = build([{ id: 'sys-1' }]);
    await expect(svc.resolve('')).resolves.toBeNull();
    expect(prisma.marketingUser.findFirst).not.toHaveBeenCalled();
  });
});
