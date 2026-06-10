import { InstallationConsumer } from './installation.consumer';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

describe('InstallationConsumer', () => {
  let prisma: MockPrismaClient;
  let bus: { on: jest.Mock };
  let jobs: { createForConversion: jest.Mock };
  let consumer: InstallationConsumer;

  const handle = (e: any) => (consumer as any).handle(e);

  beforeEach(() => {
    prisma = mockPrismaClient();
    bus = { on: jest.fn() };
    jobs = { createForConversion: jest.fn().mockResolvedValue({ id: 'job-1' }) };
    consumer = new InstallationConsumer(prisma as any, bus as any, jobs as any);
  });

  it('subscribes to marketing.lead.converted.v1 on init', () => {
    consumer.onModuleInit();
    expect(bus.on).toHaveBeenCalledWith('marketing.lead.converted.v1', expect.any(Function));
  });

  it('auto-creates a job scoped to the lead row workspace, snapshotting contact/site', async () => {
    prisma.lead.findUnique.mockResolvedValue({
      workspaceId: 'ws-1',
      contactPerson: 'Ada',
      phone: '5551112233',
      address: 'Main St',
      city: 'Istanbul',
    } as any);

    await handle({ payload: { leadId: 'l1', tenantId: 't1' } });

    // The workspaceId comes FROM THE LEAD ROW, never from the event payload.
    expect(jobs.createForConversion).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({
        tenantId: 't1',
        leadId: 'l1',
        contactName: 'Ada',
        contactPhone: '5551112233',
        siteAddress: 'Main St',
        siteCity: 'Istanbul',
      }),
    );
  });

  it('warns and skips when the event carries no leadId (no workspace anchor)', async () => {
    await handle({ payload: { leadId: null, tenantId: 't1' } });
    expect(prisma.lead.findUnique).not.toHaveBeenCalled();
    expect(jobs.createForConversion).not.toHaveBeenCalled();
  });

  it('warns and skips when the lead row is missing (cannot resolve a workspace)', async () => {
    prisma.lead.findUnique.mockResolvedValue(null);
    await handle({ payload: { leadId: 'l-gone', tenantId: 't1' } });
    expect(jobs.createForConversion).not.toHaveBeenCalled();
  });

  it('swallows errors so a bad job never aborts the event bus', async () => {
    prisma.lead.findUnique.mockResolvedValue({
      workspaceId: 'ws-1',
      contactPerson: 'Ada',
      phone: null,
      address: null,
      city: null,
    } as any);
    jobs.createForConversion.mockRejectedValue(new Error('db down'));
    await expect(handle({ payload: { leadId: 'l1', tenantId: 't1' } })).resolves.toBeUndefined();
  });
});
