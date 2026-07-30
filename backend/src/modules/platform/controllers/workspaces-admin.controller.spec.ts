import 'reflect-metadata';
import { WorkspacesAdminController } from './workspaces-admin.controller';
import { AUDIT_METADATA } from '../../audit/audit.decorator';

function makeCtrl() {
  const service: any = {
    assignPackage: jest.fn().mockResolvedValue({
      workspaceId: 'ws-1',
      packageCode: 'OPERATOR',
      status: 'ACTIVE',
      changed: true,
      limits: { dailyLeadQuota: -1 },
    }),
  };
  return { service, ctrl: new WorkspacesAdminController(service) };
}

describe('WorkspacesAdminController — PATCH :id/subscription', () => {
  it('delegates to the service with the body package code', async () => {
    const { service, ctrl } = makeCtrl();
    const res = await ctrl.assignSubscription('ws-1', {
      packageCode: 'OPERATOR',
    } as any);

    expect(service.assignPackage).toHaveBeenCalledWith('ws-1', 'OPERATOR');
    expect(res).toEqual(expect.objectContaining({ packageCode: 'OPERATOR' }));
  });

  it('is audited like the sibling status flip (operator-material mutation)', () => {
    const meta = Reflect.getMetadata(
      AUDIT_METADATA,
      WorkspacesAdminController.prototype.assignSubscription,
    );
    expect(meta).toEqual({
      action: 'workspace.subscription.assign',
      resourceType: 'workspace',
      resourceIdParam: 'id',
      captureBody: ['packageCode'],
    });
  });
});
