import { WorkflowActionHandler, WorkflowContext } from './workflow-action.handler';

/**
 * interpolate() feeds PLAIN-TEXT sinks only (sendPlainEmail text body, SMS /
 * WhatsApp / webchat). It must NOT HTML-escape — escaping there corrupts
 * legitimate content while adding no safety (the sink isn't HTML). The
 * whitelist token replace (resolveField, lead/trigger/context roots only) is
 * the injection-safe part and is exercised here implicitly.
 */
describe('WorkflowActionHandler.interpolate', () => {
  // interpolate() only touches ctx via resolveField, so the injected services
  // are irrelevant here — construct with nulls and reach the private method.
  const handler = new WorkflowActionHandler(
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any,
    null as any,
  );
  const interpolate = (tpl: string, ctx: WorkflowContext): string =>
    (handler as any).interpolate(tpl, ctx);

  const ctx: WorkflowContext = {
    workspaceId: 'ws-1',
    lead: { contactPerson: "Ben & Jerry's <VIP>" },
    trigger: {},
    context: {},
  };

  it('does NOT HTML-escape resolved values', () => {
    const out = interpolate('Hi {{lead.contactPerson}}', ctx);
    expect(out).toBe("Hi Ben & Jerry's <VIP>");
    // The old behavior would have produced &amp; / &lt; / &#39; — assert those
    // entities never appear.
    expect(out).not.toContain('&amp;');
    expect(out).not.toContain('&lt;');
    expect(out).not.toContain('&#39;');
  });

  it('replaces unknown / null tokens with empty string', () => {
    expect(interpolate('x={{lead.missing}}=y', ctx)).toBe('x==y');
  });

  it('only substitutes whitelisted {{...}} tokens, leaving other text intact', () => {
    expect(interpolate('literal {braces} & text', ctx)).toBe('literal {braces} & text');
  });
});

describe('WorkflowActionHandler send (contactIdentity race)', () => {
  it('send_sms survives a concurrent contactIdentity create (P2002) and still sends', async () => {
    const identity = { id: 'ci-1', leadId: 'lead-1' };
    const prisma = {
      channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch-1' }) },
      contactIdentity: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(null) // first: not found → attempt create
          .mockResolvedValueOnce(identity), // re-query after the P2002 → the winner
        create: jest.fn().mockRejectedValue({ code: 'P2002' }), // concurrent create won
      },
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'co-1' }) },
    };
    const sender = { send: jest.fn().mockResolvedValue(undefined) };
    const handler = new WorkflowActionHandler(
      prisma as any, null as any, null as any, null as any,
      null as any, null as any, sender as any, null as any, null as any,
    );
    const ctx: WorkflowContext = {
      workspaceId: 'ws-1',
      lead: { id: 'lead-1', phone: '5551112233' },
      trigger: {},
      context: {},
    };
    const res = await handler.execute({ type: 'send_sms', body: 'hi' } as any, ctx);
    expect(res.output?.result).toBe('SMS sent');
    expect(sender.send).toHaveBeenCalled();
  });

  // Compliance: a lead who unsubscribed must NOT receive automation messages —
  // the workflow send path (drip / nurture) has to honor the same per-channel
  // opt-out the campaign sender does. The unsubscribe flow flips these flags
  // precisely so future sends stop.
  it('send_email skips a lead who opted out of email (never sends)', async () => {
    const email = { sendPlainEmail: jest.fn().mockResolvedValue(true) };
    const handler = new WorkflowActionHandler(
      {} as any, email as any, null as any, null as any,
      null as any, null as any, null as any, null as any, null as any,
    );
    const ctx: WorkflowContext = {
      workspaceId: 'ws-1',
      lead: { id: 'lead-1', email: 'x@y.com', emailOptOut: true },
      trigger: {},
      context: {},
    };
    const res = await handler.execute({ type: 'send_email', body: 'hi' } as any, ctx);
    expect(email.sendPlainEmail).not.toHaveBeenCalled();
    expect(String(res.output?.result)).toContain('opted out');
  });

  it('send_sms skips a lead who opted out of SMS (no channel send)', async () => {
    const prisma = { channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch-1' }) } };
    const sender = { send: jest.fn().mockResolvedValue(undefined) };
    const handler = new WorkflowActionHandler(
      prisma as any, null as any, null as any, null as any,
      null as any, null as any, sender as any, null as any, null as any,
    );
    const ctx: WorkflowContext = {
      workspaceId: 'ws-1',
      lead: { id: 'lead-1', phone: '5551112233', smsOptOut: true },
      trigger: {},
      context: {},
    };
    const res = await handler.execute({ type: 'send_sms', body: 'hi' } as any, ctx);
    expect(sender.send).not.toHaveBeenCalled();
    expect(String(res.output?.result)).toContain('opted out');
  });

  // Regression: send_webchat scoped the open-conversation lookup with
  // `leadId: lead?.id`. With no lead (a lead-less subject, or a lead deleted
  // mid-run), Prisma DROPS an `undefined` where-field, so the query matched ANY
  // open web-chat conversation in the workspace — leaking the message to an
  // unrelated customer. It must skip when there is no lead (like send_email /
  // send_sms / send_whatsapp do), never fall back to an arbitrary conversation.
  it('send_webchat does NOT send to an arbitrary conversation when the run has no lead', async () => {
    const prisma = {
      channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch-1' }) },
      // If the (buggy) code reached this, it would hand back an unrelated convo.
      conversation: { findFirst: jest.fn().mockResolvedValue({ id: 'co-other-customer' }) },
    };
    const sender = { send: jest.fn().mockResolvedValue(undefined) };
    const handler = new WorkflowActionHandler(
      prisma as any, null as any, null as any, null as any,
      null as any, null as any, sender as any, null as any, null as any,
    );
    const ctx: WorkflowContext = { workspaceId: 'ws-1', lead: null, trigger: {}, context: {} };

    const res = await handler.execute({ type: 'send_webchat', body: 'hi' } as any, ctx);

    expect(sender.send).not.toHaveBeenCalled();
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
    expect(String(res.output?.result)).toContain('skipped');
  });
});

describe('WorkflowActionHandler assign_lead', () => {
  const mkHandler = (prisma: any, autoAssigner: any) =>
    new WorkflowActionHandler(
      prisma, null as any, null as any, null as any,
      autoAssigner, null as any, null as any, null as any, null as any,
    );
  const ctx: WorkflowContext = { workspaceId: 'ws-1', lead: { id: 'lead-1' }, trigger: {}, context: {} };

  // A workflow assign_lead must enforce the SAME "assignee is an ACTIVE REP"
  // guard the manual assign()/bulkAssign() paths do — otherwise a workflow could
  // dump leads on a MANAGER or a DEACTIVATED user (orphaning them on a dead
  // account). A non-active-REP target must NOT resolve, so it falls back to
  // auto-assign (the existing unresolved-user behavior).
  it('only resolves an ACTIVE REP (guards the user lookup) and falls back to auto-assign otherwise', async () => {
    const prisma = {
      marketingUser: { findFirst: jest.fn().mockResolvedValue(null) }, // target is not an active REP
      lead: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const autoAssigner = { pickAssignee: jest.fn().mockResolvedValue('rep-fallback') };
    const handler = mkHandler(prisma, autoAssigner);

    await handler.execute({ type: 'assign_lead', strategy: 'user', userId: 'mgr-1' } as any, ctx);

    expect(prisma.marketingUser.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'mgr-1', workspaceId: 'ws-1', role: 'REP', status: 'ACTIVE',
    });
    expect(autoAssigner.pickAssignee).toHaveBeenCalledWith('ws-1');
    expect(prisma.lead.updateMany.mock.calls[0][0].data.assignedToId).toBe('rep-fallback');
  });

  it('assigns directly when the target IS an active REP (no auto-assign fallback)', async () => {
    const prisma = {
      marketingUser: { findFirst: jest.fn().mockResolvedValue({ id: 'rep-1' }) },
      lead: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const autoAssigner = { pickAssignee: jest.fn() };
    const handler = mkHandler(prisma, autoAssigner);

    await handler.execute({ type: 'assign_lead', strategy: 'user', userId: 'rep-1' } as any, ctx);

    expect(autoAssigner.pickAssignee).not.toHaveBeenCalled();
    expect(prisma.lead.updateMany.mock.calls[0][0].data.assignedToId).toBe('rep-1');
  });
});

describe('WorkflowActionHandler tag actions', () => {
  const mkHandler = (tags: any) =>
    new WorkflowActionHandler(
      null as any, null as any, null as any, null as any,
      null as any, null as any, null as any, null as any,
      tags,
    );
  const ctx = (lead: any): WorkflowContext => ({
    workspaceId: 'ws-1',
    lead,
    trigger: {},
    context: {},
  });

  it('add_tag assigns the (interpolated) tag to the lead via TagsService', async () => {
    const tags = { assignToLead: jest.fn().mockResolvedValue([]) };
    const handler = mkHandler(tags);
    const res = await handler.execute(
      { type: 'add_tag', tag: 'VIP' } as any,
      ctx({ id: 'lead-1' }),
    );
    expect(tags.assignToLead).toHaveBeenCalledWith('ws-1', 'lead-1', ['VIP']);
    expect(res.output?.result).toContain('VIP');
  });

  it('add_tag is a no-op when the run has no lead', async () => {
    const tags = { assignToLead: jest.fn() };
    const handler = mkHandler(tags);
    const res = await handler.execute({ type: 'add_tag', tag: 'VIP' } as any, ctx(null));
    expect(tags.assignToLead).not.toHaveBeenCalled();
    expect(res.output?.result).toContain('skipped');
  });

  it('remove_tag unassigns only a tag actually on the lead (case-insensitive)', async () => {
    const tags = {
      getLeadTags: jest.fn().mockResolvedValue([{ id: 't-9', name: 'Vip' }]),
      unassignFromLead: jest.fn().mockResolvedValue({ removed: 1 }),
    };
    const handler = mkHandler(tags);
    const res = await handler.execute(
      { type: 'remove_tag', tag: 'vip' } as any,
      ctx({ id: 'lead-1' }),
    );
    expect(tags.unassignFromLead).toHaveBeenCalledWith('ws-1', 'lead-1', ['t-9']);
    expect(res.output?.result).toContain('Vip');
  });

  it('remove_tag never creates a tag when the lead does not carry it', async () => {
    const tags = {
      getLeadTags: jest.fn().mockResolvedValue([{ id: 't-1', name: 'Other' }]),
      unassignFromLead: jest.fn(),
    };
    const handler = mkHandler(tags);
    const res = await handler.execute(
      { type: 'remove_tag', tag: 'VIP' } as any,
      ctx({ id: 'lead-1' }),
    );
    expect(tags.unassignFromLead).not.toHaveBeenCalled();
    expect(res.output?.result).toContain('skipped');
  });
});
