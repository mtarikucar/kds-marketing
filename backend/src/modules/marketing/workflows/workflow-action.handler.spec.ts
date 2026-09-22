import { creditCost } from '../ai/ai-credit-costs';
import { verifyLeadUnsubscribeToken } from '../channels/lead-unsubscribe.token';
import { safeFetch } from '../../../common/util/safe-fetch';
import { WorkflowActionHandler, WorkflowContext } from './workflow-action.handler';

// The webhook step is the one leaf that talks to the outside world. Only the
// transport is faked — SsrfBlockedError stays the real class, because the
// handler branches on `instanceof`.
jest.mock('../../../common/util/safe-fetch', () => ({
  ...jest.requireActual('../../../common/util/safe-fetch'),
  safeFetch: jest.fn(),
}));

/**
 * The constructor is ten arguments wide and positional, so every test builds
 * the handler by NAME. A silently shifted argument is a test that proves
 * nothing, and this file has moved a dependency once already (the raw mailer
 * and the mailbox became the outbound gateway).
 */
interface HandlerDeps {
  prisma?: unknown;
  outboundMail?: unknown;
  config?: unknown;
  anthropic?: unknown;
  credits?: unknown;
  autoAssigner?: unknown;
  notifications?: unknown;
  sender?: unknown;
  reviews?: unknown;
  tags?: unknown;
}

/** A gateway that would fail the test loudly if a send reached it. */
const GATEWAY_UNUSED = {
  send: jest.fn(async () => {
    throw new Error('outboundMail.send must not be reached in this test');
  }),
};
const NO_CONFIG = { get: () => undefined };

function mkHandler(deps: HandlerDeps = {}): WorkflowActionHandler {
  return new WorkflowActionHandler(
    (deps.prisma ?? null) as any,
    (deps.outboundMail ?? GATEWAY_UNUSED) as any,
    (deps.config ?? NO_CONFIG) as any,
    (deps.anthropic ?? null) as any,
    (deps.credits ?? null) as any,
    (deps.autoAssigner ?? null) as any,
    (deps.notifications ?? null) as any,
    (deps.sender ?? null) as any,
    (deps.reviews ?? null) as any,
    (deps.tags ?? null) as any,
  );
}

/**
 * interpolate() feeds PLAIN-TEXT sinks only (the mail's text body, SMS /
 * WhatsApp / webchat). It must NOT HTML-escape — escaping there corrupts
 * legitimate content while adding no safety (the sink isn't HTML). The
 * whitelist token replace (resolveField, lead/trigger/context roots only) is
 * the injection-safe part and is exercised here implicitly.
 */
describe('WorkflowActionHandler.interpolate', () => {
  // interpolate() only touches ctx via resolveField, so the injected services
  // are irrelevant here — construct with nulls and reach the private method.
  const handler = mkHandler();
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
    const handler = mkHandler({ prisma, sender });
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

  it('send_sms skips a lead who opted out of SMS (no channel send)', async () => {
    const prisma = { channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch-1' }) } };
    const sender = { send: jest.fn().mockResolvedValue(undefined) };
    const handler = mkHandler({ prisma, sender });
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
    const handler = mkHandler({ prisma, sender });
    const ctx: WorkflowContext = { workspaceId: 'ws-1', lead: null, trigger: {}, context: {} };

    const res = await handler.execute({ type: 'send_webchat', body: 'hi' } as any, ctx);

    expect(sender.send).not.toHaveBeenCalled();
    expect(prisma.conversation.findFirst).not.toHaveBeenCalled();
    expect(String(res.output?.result)).toContain('skipped');
  });
});

describe('WorkflowActionHandler assign_lead', () => {
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
    const handler = mkHandler({ prisma, autoAssigner });

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
    const handler = mkHandler({ prisma, autoAssigner });

    await handler.execute({ type: 'assign_lead', strategy: 'user', userId: 'rep-1' } as any, ctx);

    expect(autoAssigner.pickAssignee).not.toHaveBeenCalled();
    expect(prisma.lead.updateMany.mock.calls[0][0].data.assignedToId).toBe('rep-1');
  });
});

describe('WorkflowActionHandler ai_classify (category routing)', () => {
  const ctx: WorkflowContext = { workspaceId: 'ws-1', lead: { id: 'lead-1' }, trigger: {}, context: {} };
  const step = (over: any = {}) => ({
    type: 'ai_classify',
    prompt: 'Is this lead hot?',
    categories: ['hot', 'not_hot'],
    routes: { hot: 5, not_hot: 10 },
    ...over,
  });
  const mkAi = (text: string) => ({ isEnabledFor: () => true, complete: jest.fn().mockResolvedValue({ text }) });
  const mkCredits = () => ({ reserveForJob: jest.fn(async (_ws: string, action: any, override?: number) => override ?? creditCost(action === 'brand.safety' ? 'workflow.ai_classify' : action)), refund: jest.fn() });
  const mkAiHandler = (anthropic: any, credits: any) => mkHandler({ anthropic, credits });

  // Regression: a category that is a SUBSTRING of another ("hot" ⊂ "not_hot",
  // "new" ⊂ "renew") must not steal the route. A naive `reply.includes(category)`
  // + first-match scan routed the reply "not_hot" to hot (5) — the first-listed
  // CONTAINING category — mis-routing e.g. a "not interested" lead into the
  // "interested → aggressive follow-up" branch. Exact match must win.
  it('routes an exact reply to its own category even when another category is a substring', async () => {
    const handler = mkAiHandler(mkAi('not_hot'), mkCredits());
    const res = await handler.execute(step() as any, ctx);
    expect(res.output?.category).toBe('not_hot');
    expect(res.goto).toBe(10);
  });

  it('routing is independent of category declaration order (substring listed first)', async () => {
    const handler = mkAiHandler(mkAi('renew'), mkCredits());
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
    const handler = mkAiHandler(mkAi('The category is: not_hot.'), mkCredits());
    const res = await handler.execute(step() as any, ctx);
    expect(res.output?.category).toBe('not_hot');
    expect(res.goto).toBe(10);
  });

  it('no matching category → no goto, category null (falls through to next step)', async () => {
    const handler = mkAiHandler(mkAi('cold'), mkCredits());
    const res = await handler.execute(step() as any, ctx);
    expect(res.output?.category).toBeNull();
    expect(res.goto).toBeUndefined();
  });
});

describe('WorkflowActionHandler tag actions', () => {
  const ctx = (lead: any): WorkflowContext => ({
    workspaceId: 'ws-1',
    lead,
    trigger: {},
    context: {},
  });

  it('add_tag assigns the (interpolated) tag to the lead via TagsService', async () => {
    const tags = { assignToLead: jest.fn().mockResolvedValue([]) };
    const handler = mkHandler({ tags });
    const res = await handler.execute(
      { type: 'add_tag', tag: 'VIP' } as any,
      ctx({ id: 'lead-1' }),
    );
    expect(tags.assignToLead).toHaveBeenCalledWith('ws-1', 'lead-1', ['VIP']);
    expect(res.output?.result).toContain('VIP');
  });

  it('add_tag is a no-op when the run has no lead', async () => {
    const tags = { assignToLead: jest.fn() };
    const handler = mkHandler({ tags });
    const res = await handler.execute({ type: 'add_tag', tag: 'VIP' } as any, ctx(null));
    expect(tags.assignToLead).not.toHaveBeenCalled();
    expect(res.output?.result).toContain('skipped');
  });

  it('remove_tag unassigns only a tag actually on the lead (case-insensitive)', async () => {
    const tags = {
      getLeadTags: jest.fn().mockResolvedValue([{ id: 't-9', name: 'Vip' }]),
      unassignFromLead: jest.fn().mockResolvedValue({ removed: 1 }),
    };
    const handler = mkHandler({ tags });
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
    const handler = mkHandler({ tags });
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
    mkHandler({ prisma, autoAssigner, notifications });
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
 * A workflow step must report what actually happened, and now it has to report
 * it in a shape the executor can read without sniffing English prose: `ok:
 * false` + `error` for a failure, a `skipped (…)` string for a no-op.
 */
describe('WorkflowActionHandler — an honest channel result', () => {
  it('reports an SMS the provider refused as NOT sent, and as a FAILURE', async () => {
    // SMS and WhatsApp refuse routinely — a number the carrier rejects, a
    // WhatsApp 24-hour window that has closed. Reporting that as success stops
    // anyone from trying again.
    const prisma = {
      channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch-1' }) },
      contactIdentity: { findUnique: jest.fn().mockResolvedValue({ id: 'ci-1' }) },
      conversation: {
        findFirst: jest.fn().mockResolvedValue({ id: 'convo-1' }),
        create: jest.fn().mockResolvedValue({ id: 'convo-1' }),
      },
    };
    const sender = {
      send: jest.fn().mockResolvedValue({ id: 'm1', status: 'FAILED', error: 'carrier rejected 0000' }),
    };
    const handler = mkHandler({ prisma, sender });
    const ctx: WorkflowContext = {
      workspaceId: 'ws-1',
      lead: { id: 'lead-1', phone: '+905551112233', smsOptOut: false },
      trigger: {},
      context: {},
    };

    const res = await handler.execute({ type: 'send_sms', body: 'hi' } as any, ctx);

    expect(String(res.output?.result)).toContain('NOT sent');
    expect(res.output?.ok).toBe(false);
    expect(String(res.output?.error)).toContain('carrier rejected');
  });

  it('reports a webhook the far end refused as a failure, with its status', async () => {
    (safeFetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const res = await mkHandler().execute(
      { type: 'http_webhook_out', url: 'https://example.com/hook' } as any,
      { workspaceId: 'ws-1', lead: null, trigger: {}, context: {} },
    );
    expect(res.output?.ok).toBe(false);
    expect(String(res.output?.result)).toContain('500');
  });

  it('a webhook the far end accepted is still a plain success', async () => {
    (safeFetch as jest.Mock).mockResolvedValue({ ok: true, status: 202 });
    const res = await mkHandler().execute(
      { type: 'http_webhook_out', url: 'https://example.com/hook' } as any,
      { workspaceId: 'ws-1', lead: null, trigger: {}, context: {} },
    );
    expect(res.output?.ok).not.toBe(false);
    expect(String(res.output?.result)).toBe('webhook 202');
  });
});

/**
 * THE CRITICAL (`workflow-email-noncompliant`).
 *
 * Automation mail is marketing mail to a list. It used to leave with no
 * unsubscribe link, no header, no suppression check and no meter. It now goes
 * through the outbound gateway as BULK, which is what attaches all four — and
 * the footer link is a LEAD-scoped signed token, because a drip has no
 * CampaignRecipient row to mint one from.
 */
describe('WorkflowActionHandler.send_email — the compliant path', () => {
  const KEY = Buffer.alloc(32, 11).toString('base64');
  const BASE = 'https://app.example.com';

  beforeEach(() => {
    process.env.MARKETING_SECRET_KEY = KEY;
  });
  afterEach(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  const config = { get: (k: string) => (k === 'PUBLIC_BASE_URL' ? BASE : undefined) };
  const receipt = (over: Record<string, unknown> = {}) => ({
    outcome: 'SENT',
    ok: true,
    mailLogId: 'ml-1',
    messageId: 'abc@jeeta',
    transport: 'PLATFORM',
    retriable: false,
    ...over,
  });
  const gateway = (r: Record<string, unknown> = {}) => ({ send: jest.fn().mockResolvedValue(receipt(r)) });
  const ctx = (lead: any = { id: 'lead-1', email: 'x@y.com' }): WorkflowContext => ({
    workspaceId: 'ws-1',
    lead,
    trigger: {},
    context: {},
    run: { id: 'run-1', workflowId: 'wf-1', stepIndex: 3 },
  });
  const step = { type: 'send_email', subject: 'Hello', body: 'hi' } as any;

  it('sends as BULK with a lead-scoped unsubscribe link the public route can resolve', async () => {
    const outboundMail = gateway();
    const res = await mkHandler({ outboundMail, config }).execute(step, ctx());

    const mail = outboundMail.send.mock.calls[0][0];
    expect(mail.mailClass).toBe('BULK');
    expect(mail.to).toBe('x@y.com');
    expect(mail.leadId).toBe('lead-1');
    expect(mail.source).toBe('workflow:wf-1');
    // The link is the whole point: a footer nobody can act on is worse than no
    // footer at all, so the token has to round-trip to THIS lead.
    expect(mail.unsubscribe.url).toBe(`${BASE}/api/public/ul/${mail.unsubscribe.token}`);
    expect(verifyLeadUnsubscribeToken(mail.unsubscribe.token)).toEqual({
      workspaceId: 'ws-1',
      leadId: 'lead-1',
      channel: 'EMAIL',
    });
    expect(String(res.output?.result)).toBe('email sent');
    expect(res.output?.ok).not.toBe(false);
  });

  it('keys idempotency on (run, step, lead) so a replayed step cannot mail twice', async () => {
    const outboundMail = gateway();
    await mkHandler({ outboundMail, config }).execute(step, ctx());
    expect(outboundMail.send.mock.calls[0][0].idempotencyKey).toBe('wf:run-1:3:lead-1');
  });

  it('treats a deduped send as sent, not as a failure', async () => {
    const outboundMail = gateway({ outcome: 'DEDUPED', ok: true });
    const res = await mkHandler({ outboundMail, config }).execute(step, ctx());
    expect(res.output?.ok).not.toBe(false);
    expect(String(res.output?.result)).toContain('already sent');
  });

  // The local `if (lead.emailOptOut)` gate is gone ON PURPOSE: suppression is
  // one decision in one place now (the address, not the lead row, is the unit
  // of consent), and the gateway reads the same flag plus the suppression
  // table. The step must still refuse — as a SKIP, not a failure, and without
  // throwing (a throw here FAILS the whole run).
  it('reports an opted-out lead as skipped, never as a failure and never as a throw', async () => {
    const outboundMail = gateway({
      outcome: 'REFUSED',
      ok: false,
      reason: 'SUPPRESSED_OPT_OUT',
      transport: 'NONE',
    });
    const res = await mkHandler({ outboundMail, config }).execute(
      step,
      ctx({ id: 'lead-1', email: 'x@y.com', emailOptOut: true }),
    );

    expect(outboundMail.send).toHaveBeenCalledTimes(1); // the decision is the gateway's
    expect(String(res.output?.result)).toMatch(/^skipped/);
    expect(String(res.output?.result)).toContain('opted out');
    expect(res.output?.ok).not.toBe(false);
  });

  it('reports an exhausted message quota as skipped — one step, not the whole run', async () => {
    const outboundMail = gateway({
      outcome: 'REFUSED',
      ok: false,
      reason: 'QUOTA_EXHAUSTED',
      transport: 'NONE',
    });
    const res = await mkHandler({ outboundMail, config }).execute(step, ctx());
    expect(String(res.output?.result)).toMatch(/^skipped/);
    expect(res.output?.ok).not.toBe(false);
  });

  it('records a failed send as FAILED, in the provider’s own words', async () => {
    const outboundMail = gateway({
      outcome: 'FAILED_TRANSIENT',
      ok: false,
      reason: 'TRANSIENT',
      error: '451 4.7.1 Greylisted, try again later',
      retriable: true,
    });
    const res = await mkHandler({ outboundMail, config }).execute(step, ctx());
    expect(res.output?.ok).toBe(false);
    expect(String(res.output?.result)).toContain('NOT sent');
    expect(String(res.output?.error)).toContain('Greylisted');
  });

  it('fails closed when PUBLIC_BASE_URL is unset — nothing is sent at all', async () => {
    const outboundMail = gateway();
    const res = await mkHandler({ outboundMail, config: NO_CONFIG }).execute(step, ctx());
    expect(outboundMail.send).not.toHaveBeenCalled();
    expect(res.output?.ok).toBe(false);
    expect(String(res.output?.error)).toContain('PUBLIC_BASE_URL');
  });

  it('fails closed when no key can sign the token — never mails without a way out', async () => {
    delete process.env.MARKETING_SECRET_KEY;
    const outboundMail = gateway();
    const res = await mkHandler({ outboundMail, config }).execute(step, ctx());
    expect(outboundMail.send).not.toHaveBeenCalled();
    expect(res.output?.ok).toBe(false);
  });

  // The gateway is built not to throw. This is the backstop for the day
  // something under it does: a throw here would FAIL the run and drop every
  // later step of the drip.
  it('never lets an unexpected gateway error escape as a throw', async () => {
    const outboundMail = { send: jest.fn().mockRejectedValue(new Error('prisma is down')) };
    const res = await mkHandler({ outboundMail, config }).execute(step, ctx());
    expect(res.output?.ok).toBe(false);
    expect(String(res.output?.error)).toContain('prisma is down');
  });

  it('still skips a lead with no address, before minting anything', async () => {
    const outboundMail = gateway();
    const res = await mkHandler({ outboundMail, config }).execute(step, ctx({ id: 'lead-1' }));
    expect(outboundMail.send).not.toHaveBeenCalled();
    expect(String(res.output?.result)).toBe('skipped (no lead email)');
  });

  // A run started before this shipped, or a direct execute() in a test, has no
  // run identity. The mail must still go — it simply cannot be deduped.
  it('sends without an idempotency key when the step has no run identity', async () => {
    const outboundMail = gateway();
    await mkHandler({ outboundMail, config }).execute(step, {
      workspaceId: 'ws-1',
      lead: { id: 'lead-1', email: 'x@y.com' },
      trigger: {},
      context: {},
    });
    const mail = outboundMail.send.mock.calls[0][0];
    expect(mail.idempotencyKey).toBeUndefined();
    expect(mail.source).toBe('workflow');
  });
});

/**
 * notify_user was the one producer that wrote a notification with no metadata
 * at all, under the fixed title "Automation" — nothing for the bell to open,
 * even though the recipient is by definition the lead's own owner.
 */
describe('WorkflowActionHandler notify_user', () => {
  const make = () => {
    const notifications = { create: jest.fn().mockResolvedValue({}) };
    return { handler: mkHandler({ notifications }), notifications };
  };

  it('stamps the lead it fired on so the notification has somewhere to go', async () => {
    const { handler, notifications } = make();
    const ctx: WorkflowContext = {
      workspaceId: 'ws-1',
      lead: { id: 'lead-1', assignedToId: 'u1' },
      trigger: {},
      context: {},
    };

    const res = await handler.execute({ type: 'notify_user', message: 'ping' } as any, ctx);

    expect(res.output?.result).toBe('notified');
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        userId: 'u1',
        type: 'WORKFLOW',
        metadata: { leadId: 'lead-1' },
      }),
    );
  });

  it('still skips (and writes nothing) when the lead has no owner to notify', async () => {
    const { handler, notifications } = make();
    const ctx: WorkflowContext = { workspaceId: 'ws-1', lead: null, trigger: {}, context: {} };

    const res = await handler.execute({ type: 'notify_user', message: 'ping' } as any, ctx);

    expect(res.output?.result).toBe('skipped (no user to notify)');
    expect(notifications.create).not.toHaveBeenCalled();
  });
});
