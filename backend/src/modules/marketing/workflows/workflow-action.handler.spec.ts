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
    // The sender returns the PERSISTED row; its status is what says whether the
    // provider took the message. `undefined` here meant nothing ever asserted
    // on it, which is how the handler got away with reporting every send as
    // successful.
    const sender = { send: jest.fn().mockResolvedValue({ id: 'm1', status: 'SENT' }) };
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
      // Eligibility is read from the MEMBERSHIP (the only place role/status are updated).
      workspaceMembership: { findFirst: jest.fn().mockResolvedValue(null) }, // target is not an active REP
      lead: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const autoAssigner = { pickAssignee: jest.fn().mockResolvedValue('rep-fallback') };
    const handler = mkHandler(prisma, autoAssigner);

    await handler.execute({ type: 'assign_lead', strategy: 'user', userId: 'mgr-1' } as any, ctx);

    expect(prisma.workspaceMembership.findFirst.mock.calls[0][0].where).toMatchObject({
      userId: 'mgr-1', workspaceId: 'ws-1', role: 'REP', status: 'ACTIVE',
    });
    expect(autoAssigner.pickAssignee).toHaveBeenCalledWith('ws-1');
    expect(prisma.lead.updateMany.mock.calls[0][0].data.assignedToId).toBe('rep-fallback');
  });

  it('assigns directly when the target IS an active REP (no auto-assign fallback)', async () => {
    const prisma = {
      workspaceMembership: { findFirst: jest.fn().mockResolvedValue({ userId: 'rep-1' }) },
      lead: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    const autoAssigner = { pickAssignee: jest.fn() };
    const handler = mkHandler(prisma, autoAssigner);

    await handler.execute({ type: 'assign_lead', strategy: 'user', userId: 'rep-1' } as any, ctx);

    expect(autoAssigner.pickAssignee).not.toHaveBeenCalled();
    expect(prisma.lead.updateMany.mock.calls[0][0].data.assignedToId).toBe('rep-1');
  });
});

describe('WorkflowActionHandler ai_classify (category routing)', () => {
  const mkHandler = (anthropic: any, credits: any) =>
    new WorkflowActionHandler(
      null as any, null as any, anthropic, credits,
      null as any, null as any, null as any, null as any, null as any,
    );
  const ctx: WorkflowContext = { workspaceId: 'ws-1', lead: { id: 'lead-1' }, trigger: {}, context: {} };
  const step = (over: any = {}) => ({
    type: 'ai_classify',
    prompt: 'Is this lead hot?',
    categories: ['hot', 'not_hot'],
    routes: { hot: 5, not_hot: 10 },
    ...over,
  });
  const mkAi = (text: string) => ({ isEnabled: () => true, complete: jest.fn().mockResolvedValue({ text }) });
  const mkCredits = () => ({ reserve: jest.fn(), refund: jest.fn() });

  // Regression: a category that is a SUBSTRING of another ("hot" ⊂ "not_hot",
  // "new" ⊂ "renew") must not steal the route. A naive `reply.includes(category)`
  // + first-match scan routed the reply "not_hot" to hot (5) — the first-listed
  // CONTAINING category — mis-routing e.g. a "not interested" lead into the
  // "interested → aggressive follow-up" branch. Exact match must win.
  it('routes an exact reply to its own category even when another category is a substring', async () => {
    const handler = mkHandler(mkAi('not_hot'), mkCredits());
    const res = await handler.execute(step() as any, ctx);
    expect(res.output?.category).toBe('not_hot');
    expect(res.goto).toBe(10);
  });

  it('routing is independent of category declaration order (substring listed first)', async () => {
    const handler = mkHandler(mkAi('renew'), mkCredits());
    const res = await handler.execute(
      step({ categories: ['new', 'renew'], routes: { new: 1, renew: 2 } }) as any, ctx,
    );
    expect(res.output?.category).toBe('renew');
    expect(res.goto).toBe(2);
  });

  // Lenient fallback: the model may not comply perfectly and wrap the category
  // in prose ("the category is: not_hot."). The LONGEST matching category wins
  // so specificity beats a shorter substring regardless of order.
  it('falls back to the LONGEST substring match for a chatty reply', async () => {
    const handler = mkHandler(mkAi('The category is: not_hot.'), mkCredits());
    const res = await handler.execute(step() as any, ctx);
    expect(res.output?.category).toBe('not_hot');
    expect(res.goto).toBe(10);
  });

  it('no matching category → no goto, category null (falls through to next step)', async () => {
    const handler = mkHandler(mkAi('cold'), mkCredits());
    const res = await handler.execute(step() as any, ctx);
    expect(res.output?.category).toBeNull();
    expect(res.goto).toBeUndefined();
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

/**
 * A TASK is not a LEAD. Lead ownership is REP-only for commission integrity;
 * task ownership is not. Borrowing the lead rule meant a workspace with no rep
 * — every workspace on day one — silently got NO follow-up tasks. And the
 * automated task was the only kind that arrived with no notification, because
 * this path writes the row directly instead of going through
 * MarketingTasksService.create().
 */
describe('WorkflowActionHandler create_task', () => {
  const mkTaskHandler = (prisma: any, autoAssigner: any, notifications: any = { create: jest.fn().mockResolvedValue({}) }) =>
    new WorkflowActionHandler(
      prisma, null as any, null as any, null as any,
      autoAssigner, notifications, null as any, null as any, null as any,
    );
  const taskCtx: WorkflowContext = { workspaceId: 'ws-1', lead: { id: 'lead-1' }, trigger: {}, context: {} };

  it('falls back to the workspace OWNER when there is no rep, and notifies them', async () => {
    const prisma: any = {
      marketingTask: { create: jest.fn().mockResolvedValue({ id: 'task-1' }) },
      workspaceMembership: {
        findFirst: jest.fn().mockImplementation(async ({ where }: any) =>
          where.role === 'OWNER' ? { userId: 'owner-1' } : null,
        ),
      },
    };
    const notifications = { create: jest.fn().mockResolvedValue({}) };
    const handler = mkTaskHandler(prisma, { pickAssignee: jest.fn().mockResolvedValue(null) }, notifications);

    const res = await handler.execute({ type: 'create_task', title: 'Ara X' } as any, taskCtx);

    expect(res.output?.result).toBe('task created');
    expect(prisma.marketingTask.create.mock.calls[0][0].data.assignedToId).toBe('owner-1');
    // The reminder has to actually remind.
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner-1', type: 'TASK_ASSIGNED', workspaceId: 'ws-1' }),
    );
  });

  it('prefers the lead owner, before the rep pool or the fallback', async () => {
    const prisma: any = {
      marketingTask: { create: jest.fn().mockResolvedValue({ id: 'task-2' }) },
      workspaceMembership: { findFirst: jest.fn() },
    };
    const autoAssigner = { pickAssignee: jest.fn() };
    const handler = mkTaskHandler(prisma, autoAssigner);

    await handler.execute({ type: 'create_task', title: 't' } as any, {
      ...taskCtx,
      lead: { id: 'lead-1', assignedToId: 'rep-owner' },
    } as any);

    expect(prisma.marketingTask.create.mock.calls[0][0].data.assignedToId).toBe('rep-owner');
    expect(autoAssigner.pickAssignee).not.toHaveBeenCalled();
    expect(prisma.workspaceMembership.findFirst).not.toHaveBeenCalled();
  });

  it('still creates the task when the notification throws', async () => {
    const prisma: any = {
      marketingTask: { create: jest.fn().mockResolvedValue({ id: 'task-3' }) },
      workspaceMembership: { findFirst: jest.fn().mockResolvedValue({ userId: 'owner-1' }) },
    };
    const notifications = { create: jest.fn().mockRejectedValue(new Error('notif down')) };
    const handler = mkTaskHandler(prisma, { pickAssignee: jest.fn().mockResolvedValue(null) }, notifications);

    const res = await handler.execute({ type: 'create_task', title: 't' } as any, taskCtx);

    expect(res.output?.result).toBe('task created');
  });

  it('still skips when the workspace has nobody active at all', async () => {
    const prisma: any = {
      marketingTask: { create: jest.fn() },
      workspaceMembership: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const handler = mkTaskHandler(prisma, { pickAssignee: jest.fn().mockResolvedValue(null) });

    const res = await handler.execute({ type: 'create_task', title: 't' } as any, taskCtx);

    expect(res.output?.result).toContain('skipped');
    expect(prisma.marketingTask.create).not.toHaveBeenCalled();
  });
});

/**
 * A workflow step must report what actually happened.
 *
 * Every other branch of send() already does — "skipped (no lead email)",
 * "skipped (lead opted out of email)", "skipped (no active SMS channel)". The
 * email branch returned "email sent" whether or not it was, because it ignored
 * sendPlainEmail's return value. A workflow run could therefore show a customer
 * as contacted when nothing reached them, which is worse than a visible
 * failure: it stops anyone from trying again.
 */
describe('WorkflowActionHandler.send_email — honest result', () => {
  const make = (sendOk: boolean) => {
    const email = { sendPlainEmail: jest.fn().mockResolvedValue(sendOk) };
    const handler = new WorkflowActionHandler(
      {} as any, email as any, null as any, null as any,
      null as any, null as any, null as any, null as any, null as any,
    );
    const ctx: WorkflowContext = {
      workspaceId: 'ws-1',
      lead: { id: 'lead-1', email: 'x@y.com', emailOptOut: false },
      trigger: {},
      context: {},
    };
    return { handler, ctx, email };
  };

  it('says sent when it went', async () => {
    const { handler, ctx } = make(true);
    const res = await handler.execute({ type: 'send_email', body: 'hi' } as any, ctx);
    expect(String(res.output?.result)).toBe('email sent');
  });

  it('reports an SMS the provider refused as NOT sent', async () => {
    // The channel branches had the same bug as the email branch one level up,
    // and it bites harder here: SMS and WhatsApp refuse routinely — a number
    // the carrier rejects, a WhatsApp 24-hour window that has closed.
    const prisma = {
      channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch-1' }) },
      contactIdentity: { findUnique: jest.fn().mockResolvedValue({ id: 'ci-1' }) },
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'convo-1' }),
        create: jest.fn().mockResolvedValue({ id: 'convo-1' }),
      },
    };
    const sender = { send: jest.fn().mockResolvedValue({ id: 'm1', status: 'FAILED' }) };
    const handler = new WorkflowActionHandler(
      prisma as any, null as any, null as any, null as any,
      null as any, null as any, sender as any, null as any, null as any,
    );
    const ctx: WorkflowContext = {
      workspaceId: 'ws-1',
      lead: { id: 'lead-1', phone: '+905551112233', smsOptOut: false },
      trigger: {},
      context: {},
    };

    const res = await handler.execute({ type: 'send_sms', body: 'hi' } as any, ctx);

    expect(String(res.output?.result)).toContain('NOT sent');
  });

  it('says NOT sent when delivery failed', async () => {
    const { handler, ctx, email } = make(false);
    const res = await handler.execute({ type: 'send_email', body: 'hi' } as any, ctx);

    expect(email.sendPlainEmail).toHaveBeenCalled();
    expect(String(res.output?.result)).toContain('NOT sent');
  });
});
