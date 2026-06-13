import { mockDeep, DeepMockProxy } from 'jest-mock-extended';
import { Prisma, PrismaClient } from '@prisma/client';
import { AuditLogService } from './audit-log.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('AuditLogService', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let service: AuditLogService;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    service = new AuditLogService(prisma as unknown as PrismaService);
  });

  it('maps a full entry onto an audit_log insert', async () => {
    await service.record({
      actorType: 'PLATFORM_OPERATOR',
      actorId: 'op-1',
      actorEmail: 'op@example.com',
      action: 'workspace.status.update',
      resourceType: 'workspace',
      resourceId: 'ws-9',
      workspaceId: null,
      requestId: 'req-1',
      ip: '203.0.113.5',
      outcome: 'SUCCESS',
      metadata: { status: 'SUSPENDED' },
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: 'PLATFORM_OPERATOR',
        actorId: 'op-1',
        actorEmail: 'op@example.com',
        action: 'workspace.status.update',
        resourceType: 'workspace',
        resourceId: 'ws-9',
        requestId: 'req-1',
        ip: '203.0.113.5',
        outcome: 'SUCCESS',
        metadata: { status: 'SUSPENDED' },
      }),
    });
  });

  it('defaults outcome to SUCCESS and writes JsonNull when there is no metadata', async () => {
    await service.record({
      actorType: 'SYSTEM',
      action: 'lead.status.update',
      resourceType: 'lead',
      resourceId: 'lead-1',
    });

    const { data } = (prisma.auditLog.create as jest.Mock).mock.calls[0][0];
    expect(data.outcome).toBe('SUCCESS');
    expect(data.metadata).toBe(Prisma.JsonNull);
    expect(data.actorId).toBeNull();
  });

  it('is non-fatal: a failed insert is swallowed, never thrown', async () => {
    (prisma.auditLog.create as jest.Mock).mockRejectedValue(
      new Error('db down'),
    );
    await expect(
      service.record({
        actorType: 'MARKETING_USER',
        action: 'commission.approve',
        resourceType: 'commission',
        resourceId: 'c-1',
      }),
    ).resolves.toBeUndefined();
  });

  it('exposes only an append path (no update/delete on the service)', () => {
    expect((service as unknown as Record<string, unknown>).update).toBeUndefined();
    expect((service as unknown as Record<string, unknown>).delete).toBeUndefined();
    expect(typeof service.record).toBe('function');
  });
});
