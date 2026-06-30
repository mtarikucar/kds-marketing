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
  let affiliates: { attributeReferral: jest.Mock };
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
    affiliates = { attributeReferral: jest.fn().mockResolvedValue(false) };
    svc = new FormsService(prisma as any, outbox as any, autoAssigner as any, affiliates as any);
  });

  it('creates a workspace-scoped lead and emits LeadCreated + FormSubmitted', async () => {
    const res = await svc.submit('f1', { name: 'Ada', email: 'ada@x.com', phone: '5551112233' });
    expect(res.redirectUrl).toBeNull();
    expect(prisma.lead.create.mock.calls[0][0].data).toMatchObject({ workspaceId: WS, email: 'ada@x.com', source: 'WEBSITE' });
    const types = outbox.append.mock.calls.map((c) => c[0].type);
    expect(types).toContain('marketing.lead.created.v1');
    expect(types).toContain('marketing.form.submitted.v1');
  });

  it('emits FormSubmitted INSIDE the lead transaction (durable iff the lead commits)', async () => {
    await svc.submit('f1', { name: 'Ada', email: 'ada@x.com' });
    const formSubmitted = outbox.append.mock.calls.find((c) => c[0].type === 'marketing.form.submitted.v1');
    expect(formSubmitted).toBeDefined();
    // 2nd arg = the transaction client (same as LeadCreated), so the form.submitted
    // workflow trigger is durable iff the lead row is — not a best-effort emit
    // after commit that can 500 the visitor or silently drop the trigger.
    expect(formSubmitted![1]).toBe(prisma);
  });

  it('de-dupes onto an existing lead by email (no new lead)', async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-9' });
    await svc.submit('f1', { name: 'Ada', email: 'ada@x.com' });
    expect(prisma.lead.create).not.toHaveBeenCalled();
    // still emits FormSubmitted for the existing lead
    expect(outbox.append.mock.calls.map((c) => c[0].type)).toContain('marketing.form.submitted.v1');
  });

  it('does NOT de-dupe onto a soft-deleted lead (a new inquiry must stay visible)', async () => {
    // A bulk-deleted (deletedAt) lead is hidden from the list; matching a new
    // form submission onto it would attach the inquiry to an invisible record.
    // The dedup read must exclude soft-deleted leads, just like merged ones.
    await svc.submit('f1', { name: 'Ada', email: 'ada@x.com', phone: '5551112233' });
    const where = prisma.lead.findFirst.mock.calls[0][0].where;
    expect(where.mergedIntoId).toBeNull();
    expect(where.deletedAt).toBeNull();
  });
});
