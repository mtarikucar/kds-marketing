import { SocialCampaignsController } from './social-campaigns.controller';

const u: any = { workspaceId: 'ws-1', id: 'u-1' };

function build() {
  const svc = {
    create: jest.fn().mockResolvedValue({ id: 'c-1' }),
    list: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue({ id: 'c-1' }),
    update: jest.fn().mockResolvedValue({ id: 'c-1' }),
    activate: jest.fn().mockResolvedValue({ id: 'c-1', status: 'ACTIVE' }),
    pause: jest.fn(), resume: jest.fn(), cancel: jest.fn(),
    listItems: jest.fn().mockResolvedValue([]),
    confirmPlan: jest.fn().mockResolvedValue({ confirmed: 0 }),
    approveItem: jest.fn(), rejectItem: jest.fn(), regenerateItem: jest.fn(),
  };
  return { ctrl: new SocialCampaignsController(svc as any), svc };
}

describe('SocialCampaignsController', () => {
  it('create passes workspaceId + createdById and coerces dates', async () => {
    const { ctrl, svc } = build();
    await ctrl.create({
      name: 'Launch', brief: { audience: 'x' }, automationMode: 'APPROVAL', planningMode: 'AI_FULL',
      cadence: { daysOfWeek: [1], timeOfDay: '09:00' }, startDate: '2026-07-01T00:00:00Z',
      targetAccountIds: ['acc-1'], mediaKinds: ['IMAGE'],
    } as any, u);
    expect(svc.create).toHaveBeenCalledWith('ws-1', expect.objectContaining({
      name: 'Launch', createdById: 'u-1', startDate: new Date('2026-07-01T00:00:00Z'),
    }));
  });

  it('activate delegates by id', async () => {
    const { ctrl, svc } = build();
    await ctrl.activate('c-1', u);
    expect(svc.activate).toHaveBeenCalledWith('ws-1', 'c-1');
  });

  it('confirmPlan delegates', async () => {
    const { ctrl, svc } = build();
    await ctrl.confirmPlan('c-1', u);
    expect(svc.confirmPlan).toHaveBeenCalledWith('ws-1', 'c-1');
  });

  it('item actions delegate by itemId', async () => {
    const { ctrl, svc } = build();
    await ctrl.approveItem('i-1', u);
    await ctrl.rejectItem('i-1', u);
    await ctrl.regenerateItem('i-1', u);
    expect(svc.approveItem).toHaveBeenCalledWith('ws-1', 'i-1');
    expect(svc.rejectItem).toHaveBeenCalledWith('ws-1', 'i-1');
    expect(svc.regenerateItem).toHaveBeenCalledWith('ws-1', 'i-1');
  });
});
