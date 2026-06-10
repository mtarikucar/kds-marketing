import { FormsService } from './forms.service';

/**
 * Public form submission: resolves the workspace from the FormDef, creates a
 * workspace-scoped lead (or de-dupes by email/phone), and emits LeadCreated +
 * FormSubmitted (workflow triggers).
 */
describe('FormsService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let outbox: { append: jest.Mock };
  let autoAssigner: { pickAssignee: jest.Mock };
  let svc: FormsService;

  beforeEach(() => {
    prisma = {
      formDef: { findUnique: jest.fn().mockResolvedValue({ id: 'f1', workspaceId: WS, name: 'Contact', redirectUrl: null }) },
      lead: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'lead-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      leadActivity: { create: jest.fn().mockResolvedValue({}) },
      marketingUser: { findFirst: jest.fn().mockResolvedValue({ id: 'sys-1' }) },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    outbox = { append: jest.fn().mockResolvedValue('evt') };
    autoAssigner = { pickAssignee: jest.fn().mockResolvedValue(null) };
    svc = new FormsService(prisma as any, outbox as any, autoAssigner as any);
  });

  it('creates a workspace-scoped lead and emits LeadCreated + FormSubmitted', async () => {
    const res = await svc.submit('f1', { name: 'Ada', email: 'ada@x.com', phone: '5551112233' });
    expect(res.redirectUrl).toBeNull();
    expect(prisma.lead.create.mock.calls[0][0].data).toMatchObject({ workspaceId: WS, email: 'ada@x.com', source: 'WEBSITE' });
    const types = outbox.append.mock.calls.map((c) => c[0].type);
    expect(types).toContain('marketing.lead.created.v1');
    expect(types).toContain('marketing.form.submitted.v1');
  });

  it('de-dupes onto an existing lead by email (no new lead)', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-9' });
    await svc.submit('f1', { name: 'Ada', email: 'ada@x.com' });
    expect(prisma.lead.create).not.toHaveBeenCalled();
    // still emits FormSubmitted for the existing lead
    expect(outbox.append.mock.calls.map((c) => c[0].type)).toContain('marketing.form.submitted.v1');
  });
});
