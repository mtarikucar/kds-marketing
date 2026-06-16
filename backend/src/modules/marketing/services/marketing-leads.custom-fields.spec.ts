import { MarketingLeadsService } from './marketing-leads.service';
import {
  mockPrismaClient,
  MockPrismaClient,
} from '../../../common/test/prisma-mock.service';

/**
 * Epic A1 — the leads service routes any incoming `customFields` map through
 * CustomFieldsService.validateAndNormalize before persisting, and persists the
 * normalized (coerced) result, not the raw input.
 */
describe('MarketingLeadsService — customFields validation', () => {
  let prisma: MockPrismaClient;
  let svc: MarketingLeadsService;
  let cf: { validateAndNormalize: jest.Mock };

  beforeEach(() => {
    prisma = mockPrismaClient();
    cf = { validateAndNormalize: jest.fn().mockResolvedValue({ budget: 1500 }) };
    svc = new MarketingLeadsService(
      prisma as any,
      {} as any, // emailService
      { pickAssignee: jest.fn().mockResolvedValue(null) } as any, // autoAssigner
      {} as any, // provisioning
      { append: jest.fn() } as any, // outbox
      cf as any, // customFields
    );
    prisma.lead.findFirst.mockResolvedValue(null);
    prisma.lead.create.mockResolvedValue({ id: 'lead-1', customFields: { budget: 1500 } } as any);
  });

  it('normalizes customFields on create and persists the coerced map', async () => {
    await svc.create(
      'ws-1',
      {
        businessName: 'X',
        contactPerson: 'Y',
        businessType: 'CAFE',
        source: 'WEBSITE',
        customFields: { budget: '1500' },
      } as any,
      'u1',
      'OWNER',
    );
    expect(cf.validateAndNormalize).toHaveBeenCalledWith('ws-1', 'LEAD', { budget: '1500' }, 'create');
    expect(prisma.lead.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customFields: { budget: 1500 } }),
      }),
    );
  });

  it('merges normalized customFields onto the existing map on update', async () => {
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      assignedToId: 'u1',
      customFields: { tier: 'gold' },
    } as any);
    cf.validateAndNormalize.mockResolvedValue({ budget: 2000 });
    prisma.lead.update.mockResolvedValue({ id: 'lead-1', updatedAt: new Date() } as any);

    await svc.update('ws-1', 'lead-1', { customFields: { budget: '2000' } } as any, 'u1', 'OWNER');

    expect(cf.validateAndNormalize).toHaveBeenCalledWith('ws-1', 'LEAD', { budget: '2000' }, 'update');
    expect(prisma.lead.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ customFields: { tier: 'gold', budget: 2000 } }),
      }),
    );
  });
});
