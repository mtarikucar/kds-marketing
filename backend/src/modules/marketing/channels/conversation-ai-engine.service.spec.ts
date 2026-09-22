import { ConversationAiEngineService } from './conversation-ai-engine.service';
import { ConversationFollowupService } from './conversation-followup.service';

/**
 * The Conversation AI engine's gate chain + reply behavior. Every gate
 * (paused, no agent, daily cap, AI off) must stop a reply; the happy path
 * sends one AI message + meters a credit; a handoff tool pauses the AI without
 * sending and refunds the unused credit.
 */
describe('ConversationAiEngineService.reply', () => {
  const WS = 'ws-1';
  const CONVO = 'conv-1';
  const today = new Date().toISOString().slice(0, 10);

  function build(overrides: {
    aiExecution?: string;
    slots?: string[];
    convo?: any;
    channel?: any;
    agent?: any;
    enabled?: boolean;
    complete?: any;
    history?: any;
    claimed?: number;
    sendStatus?: 'SENT' | 'FAILED';
    sendRetriable?: boolean;
    metered?: boolean;
    usage?: { limit: number; used: number; remaining: number };
    /** The thread's lead row, for the deleted/merged gate. */
    lead?: any;
  } = {}) {
    const convo = {
      id: CONVO,
      channelId: 'ch-1',
      leadId: 'lead-1',
      status: 'OPEN',
      aiPaused: false,
      aiRepliesToday: 0,
      aiRepliesDayKey: today,
      followupCount: 0,
      ...overrides.convo,
    };
    const channel = { id: 'ch-1', status: 'ACTIVE', agentProfileId: 'ag-1', ...overrides.channel };
    const agent = {
      id: 'ag-1',
      status: 'ACTIVE',
      persona: 'You are a helpful assistant.',
      tone: null,
      goals: null,
      guardrails: null,
      language: 'tr',
      maxRepliesPerConvoDaily: 30,
      handoffRules: {},
      followup: { enabled: false },
      kbDocIds: [],
      ...overrides.agent,
    };
    const prisma: any = {
      // Who does this workspace's AI work. Defaults to SERVER so every test
      // written before the connector lane existed still describes the platform
      // answering; the handoff tests set it explicitly.
      workspace: { findUnique: jest.fn().mockResolvedValue({ aiExecution: overrides.aiExecution ?? 'SERVER' }) },
      agentRun: { findFirst: jest.fn().mockResolvedValue(null) },
      conversation: {
        findFirst: jest.fn().mockResolvedValue(convo),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      channel: { findFirst: jest.fn().mockResolvedValue(channel) },
      agentProfile: { findFirst: jest.fn().mockResolvedValue(agent) },
      message: {
        findMany: jest.fn().mockResolvedValue(overrides.history ?? [{ direction: 'INBOUND', body: 'Merhaba' }]),
      },
      lead: {
        findFirst: jest
          .fn()
          .mockResolvedValue(
            overrides.lead === undefined
              ? { businessName: 'Acme', contactPerson: 'Ayşe' }
              : overrides.lead,
          ),
        // "Does another live lead already hold this dedup key?" — 0 = free.
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      booking: { findFirst: jest.fn().mockResolvedValue(null) },
      // The audit trail a capture now leaves. Needs the workspace SYSTEM
      // sentinel, because LeadActivity.createdById is a required FK.
      leadActivity: { create: jest.fn().mockResolvedValue({}) },
      marketingUser: { findFirst: jest.fn().mockResolvedValue({ id: 'sys-1' }) },
      marketingNotification: { create: jest.fn().mockResolvedValue({}) },
      conversationNote: { create: jest.fn().mockResolvedValue({}) },
      // Atomic daily-reply-cap claim: returns rows-affected (1 = slot claimed,
      // 0 = at cap / lost race). Default 1; the cap-hit test overrides to 0.
      $executeRaw: jest.fn().mockResolvedValue(overrides.claimed ?? 1),
    };
    // The monthly message pool. Unlimited by default so every test written
    // before the headroom gate existed still describes the old behaviour.
    const quota = {
      isMetered: jest.fn().mockReturnValue(overrides.metered ?? true),
      usage: jest.fn().mockResolvedValue(overrides.usage ?? { limit: -1, used: 0, remaining: -1 }),
    };
    const outbox = { append: jest.fn().mockResolvedValue(undefined) };
    const anthropic = {
      isEnabled: jest.fn().mockReturnValue(overrides.enabled ?? true),
      // Workspace-aware gate: a workspace with its own key is live even while
      // the shared platform key is refusing. The reply path asks this one.
      isEnabledFor: jest.fn().mockResolvedValue(overrides.enabled ?? true),
      complete: jest.fn().mockResolvedValue(
        overrides.complete ?? { text: 'Merhaba! Size nasıl yardımcı olabilirim?', toolUses: [], stopReason: 'end_turn', usage: { input: 1, output: 1 } },
      ),
    };
    const credits = {
      reserveForJob: jest.fn().mockResolvedValue(1),
      refund: jest.fn().mockResolvedValue(undefined),
    };
    const knowledge = { search: jest.fn().mockResolvedValue([]) };
    // MessageSenderService returns the PERSISTED row, whose status is 'SENT' or
    // 'FAILED' — it does not throw on a provider rejection. The engine reads
    // that status, so the double must carry it.
    const sender = {
      send: jest.fn().mockResolvedValue({
        id: 'out-1',
        status: overrides.sendStatus ?? 'SENT',
        // Whether sending THIS message again, unchanged, could have a different
        // answer. Absent (the default) means the dispatcher could not tell, and
        // the engine must then treat the failure as final — today's behaviour.
        ...(overrides.sendRetriable === undefined ? {} : { retriable: overrides.sendRetriable }),
      }),
    };
    const scheduledJobs = { schedule: jest.fn().mockResolvedValue('job'), cancel: jest.fn().mockResolvedValue(true) };
    const runner = { registerHandler: jest.fn() };
    const stream = { push: jest.fn() };
    const brandContext = { summaryFor: jest.fn().mockResolvedValue(null) };
    // The real policy parsing, not a stub: these tests turn chasing on and off
    // through `agent.followup`, and a double that answered "yes, chase" for
    // every shape would let a broken policy read pass every one of them.
    const followups = new ConversationFollowupService(prisma as any, scheduledJobs as any);
    // Lets a conversation become a meeting. Only reachable when the agent has
    // a calendar attached — see the block at the bottom.
    const bookings = {
      availability: jest.fn().mockResolvedValue(overrides.slots ?? ['2026-09-15T10:00:00.000Z']),
      book: jest.fn().mockResolvedValue({ id: 'bk-1' }),
    };
    const engine = new ConversationAiEngineService(
      prisma, {} as any, anthropic as any, credits as any, knowledge as any,
      sender as any, scheduledJobs as any, runner as any, stream as any,
      brandContext as any, followups, bookings as any, quota as any, outbox as any,
    );
    return { engine, prisma, anthropic, credits, sender, scheduledJobs, stream, brandContext, followups, bookings, quota, outbox };
  }

  const run = (h: any) => (h.engine as any).reply(WS, CONVO);

  describe.each(['reply', 'followup'] as const)('%s credit reservation receipts', (kind) => {
    it.each([0, 7])('refunds only the actual receipt (%i) when delivery fails', async (charged) => {
      const h = build({ sendStatus: 'FAILED', agent: { followup: { enabled: true, afterHours: 24, maxFollowups: 3 } } });
      h.credits.reserveForJob.mockResolvedValue(charged);
      h.prisma.workspace.findUnique.mockResolvedValue({ aiExecution: 'SERVER', aiApiKeyEnc: charged === 0 ? 'byok' : null });
      if (kind === 'reply') await run(h);
      else await (h.engine as any).handleFollowupJob({ payload: { workspaceId: WS, conversationId: CONVO } });
      expect(h.credits.reserveForJob).toHaveBeenCalledWith(WS, `conversation.${kind}`);
      expect(h.sender.send).toHaveBeenCalled();
      if (charged === 0) expect(h.credits.refund).not.toHaveBeenCalled();
      else expect(h.credits.refund).toHaveBeenCalledWith(WS, 7);
    });

    it('refunds the captured charge when generation throws', async () => {
      const h = build({ agent: { followup: { enabled: true, afterHours: 24, maxFollowups: 3 } } });
      h.credits.reserveForJob.mockResolvedValue(7);
      h.anthropic.complete.mockRejectedValue(new Error('provider unavailable'));
      const work = kind === 'reply' ? run(h)
        : (h.engine as any).handleFollowupJob({ payload: { workspaceId: WS, conversationId: CONVO } });
      await expect(work).rejects.toThrow('provider unavailable');
      expect(h.credits.refund).toHaveBeenCalledWith(WS, 7);
      expect(h.sender.send).not.toHaveBeenCalled();
    });
  });

  describe('per-action policy', () => {
    it('does not send a reply disabled while its model call was running', async () => {
      const h = build();
      h.anthropic.complete.mockImplementation(async () => {
        h.prisma.workspace.findUnique.mockResolvedValue({ aiSpendPolicy: { jobs: { 'conversation.reply': { enabled: false } } } });
        return { text: 'No longer allowed', toolUses: [], stopReason: 'end_turn' };
      });
      await expect(run(h)).rejects.toThrow();
      expect(h.sender.send).not.toHaveBeenCalled();
    });

    it('does not send a follow-up switched to MCP while its model call was running', async () => {
      const h = build({ agent: { followup: { enabled: true, afterHours: 24, maxFollowups: 3 } } });
      h.anthropic.complete.mockImplementation(async () => {
        h.prisma.workspace.findUnique.mockResolvedValue({ aiSpendPolicy: { jobs: { 'conversation.followup': { provider: 'MCP' } } } });
        return { text: 'No longer allowed', toolUses: [], stopReason: 'end_turn' };
      });
      await expect((h.engine as any).handleFollowupJob({ payload: { workspaceId: WS, conversationId: CONVO } })).rejects.toThrow();
      expect(h.sender.send).not.toHaveBeenCalled();
    });

    it.each(['API', 'MCP'])('does not run a disabled reply (%s)', async (provider) => {
      const h = build();
      h.prisma.workspace.findUnique.mockResolvedValue({ aiSpendPolicy: { jobs: { 'conversation.reply': { enabled: false, provider } } } });
      await expect(run(h)).rejects.toThrow();
      expect(h.anthropic.complete).not.toHaveBeenCalled();
      expect(h.credits.reserveForJob).not.toHaveBeenCalled();
    });

    it('refuses an existing server reply after its provider changes to MCP', async () => {
      const h = build();
      h.prisma.workspace.findUnique.mockResolvedValue({ aiSpendPolicy: { jobs: { 'conversation.reply': { provider: 'MCP' } } } });
      await expect(run(h)).rejects.toThrow();
      expect(h.sender.send).not.toHaveBeenCalled();
    });

    it('executes a queued follow-up as a follow-up even when replies are disabled', async () => {
      const h = build({ agent: { followup: { enabled: true, afterHours: 24, maxFollowups: 3 } } });
      h.prisma.workspace.findUnique.mockResolvedValue({ aiExecution: 'MCP_ONLY', aiSpendPolicy: { jobs: {
        'conversation.reply': { enabled: false }, 'conversation.followup': { enabled: true, provider: 'API' },
      } } });
      await (h.engine as any).handleAiReplyJob({ workspaceId: WS, payload: { workspaceId: WS, conversationId: CONVO, reason: 'followup' } });
      expect(h.anthropic.complete).toHaveBeenCalledWith(expect.objectContaining({ action: 'conversation.followup' }));
      expect(h.sender.send).toHaveBeenCalled();
    });

    it('does not execute or hand off a disabled follow-up', async () => {
      const h = build({ aiExecution: 'MCP', agent: { followup: { enabled: true, afterHours: 24, maxFollowups: 3 } } });
      h.prisma.workspace.findUnique.mockResolvedValue({ aiExecution: 'MCP', aiSpendPolicy: { jobs: { 'conversation.followup': { enabled: false } } } });
      await (h.engine as any).handleFollowupJob({ payload: { workspaceId: WS, conversationId: CONVO } });
      expect(h.scheduledJobs.schedule).not.toHaveBeenCalled();
      expect(h.credits.reserveForJob).not.toHaveBeenCalled();
    });

    it('hands off an explicit MCP follow-up despite BYOK and disabled replies', async () => {
      const h = build({ agent: { followup: { enabled: true, afterHours: 24, maxFollowups: 3 } } });
      h.prisma.workspace.findUnique.mockResolvedValue({ aiExecution: 'SERVER', aiApiKeyEnc: 'own-key', aiSpendPolicy: { jobs: {
        'conversation.reply': { enabled: false, provider: 'API' }, 'conversation.followup': { enabled: true, provider: 'MCP' },
      } } });
      await (h.engine as any).handleFollowupJob({ payload: { workspaceId: WS, conversationId: CONVO } });
      expect(h.scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({ kind: 'conversation.ai_reply', payload: { workspaceId: WS, conversationId: CONVO, reason: 'followup' } }));
      expect(h.anthropic.complete).not.toHaveBeenCalled();
    });

    it('executes a legacy follow-up already released by the scheduler without requeueing it to MCP', async () => {
      const h = build({ aiExecution: 'MCP', agent: { followup: { enabled: true, afterHours: 24, maxFollowups: 3 } } });
      await (h.engine as any).handleAiReplyJob({ workspaceId: WS, payload: { workspaceId: WS, conversationId: CONVO, reason: 'followup' } });
      expect(h.anthropic.complete).toHaveBeenCalledWith(expect.objectContaining({ action: 'conversation.followup' }));
      expect(h.scheduledJobs.schedule).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'conversation.ai_reply' }));
    });
  });

  /**
   * A nudge under a connector mode goes to the CONNECTOR.
   *
   * The platform-key check used to stand at the very top of the follow-up
   * handler, so on a workspace whose Claude answers through the connector every
   * scheduled nudge was dropped on arrival by the one answerer that was never
   * going to write it. Chasing a quiet customer was silently conditional on the
   * platform doing the chasing.
   */
  describe('a nudge under a connector mode', () => {
    const chases = { agent: { followup: { enabled: true, afterHours: 24, maxFollowups: 3 } } };
    const fire = (h: any) =>
      (h.engine as any).handleFollowupJob({ payload: { workspaceId: WS, conversationId: CONVO } });

    it('is handed to the connector, and spends no platform key', async () => {
      const h = build({ ...chases, aiExecution: 'MCP' });
      await fire(h);
      expect(h.scheduledJobs.schedule).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'conversation.ai_reply',
          dedupKey: CONVO,
          payload: expect.objectContaining({ reason: 'followup' }),
        }),
      );
      expect(h.sender.send).not.toHaveBeenCalled();
      expect(h.credits.reserveForJob).not.toHaveBeenCalled();
    });

    it('carries a reason, because a nudge is not an answer', async () => {
      // Without it the connector writes a reply to a question nobody asked.
      const h = build({ ...chases, aiExecution: 'MCP_ONLY' });
      await fire(h);
      const payload = h.scheduledJobs.schedule.mock.calls[0][0].payload;
      expect(payload.reason).toBe('followup');
    });

    it('reaches the connector only AFTER every gate about the customer has run', async () => {
      // Handing over first and hoping the client re-checks would put a legal
      // obligation on the far side of an interface we do not control. An
      // opted-out contact must produce no job at all.
      const h = build({ ...chases, aiExecution: 'MCP', channel: { type: 'EMAIL' } });
      h.prisma.lead.findFirst.mockResolvedValue({ businessName: 'Acme', emailOptOut: true });
      await fire(h);
      expect(h.scheduledJobs.schedule).not.toHaveBeenCalled();
    });

    it('still runs on the platform when the workspace has no connector', async () => {
      const h = build({ ...chases, aiExecution: 'SERVER' });
      await fire(h);
      expect(h.scheduledJobs.schedule).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'conversation.ai_reply' }),
      );
      expect(h.sender.send).toHaveBeenCalled();
    });
  });

  // A proactive follow-up fires hours after the last reply. If the lead was
  // bulk-deleted/merged in the meantime, the conversation may still be OPEN but
  // we must NOT re-engage them (bulk-delete means "stop contacting"). The lead
  // load applies the active predicate; a vanished lead skips the nudge before a
  // credit is even reserved.
  it('proactive follow-up: skips (no send, no credit) when the lead was deleted/merged', async () => {
    const h = build({ agent: { followup: { enabled: true, afterHours: 24, maxFollowups: 3 } } });
    h.prisma.lead.findFirst.mockResolvedValue(null); // active predicate excludes the deleted lead
    await (h.engine as any).handleFollowupJob({ payload: { workspaceId: WS, conversationId: CONVO } });
    expect(h.sender.send).not.toHaveBeenCalled();
    expect(h.credits.reserveForJob).not.toHaveBeenCalled();
  });

  // İYS/KVKK: a proactive follow-up is an unsolicited COMMERCIAL re-engagement,
  // so it must honor the per-channel marketing opt-out — the contact may have
  // unsubscribed in the hours between the last reply and the job firing.
  it('proactive follow-up: suppressed (no send, no credit) when the contact opted out of the channel', async () => {
    const h = build({
      agent: { followup: { enabled: true, afterHours: 24, maxFollowups: 3 } },
      channel: { type: 'WHATSAPP' },
    });
    h.prisma.lead.findFirst.mockResolvedValue({ businessName: 'Acme', contactPerson: 'Ayşe', waOptOut: true });
    await (h.engine as any).handleFollowupJob({ payload: { workspaceId: WS, conversationId: CONVO } });
    expect(h.sender.send).not.toHaveBeenCalled();
    expect(h.credits.reserveForJob).not.toHaveBeenCalled();
  });

  it('proactive follow-up: an opt-out on a DIFFERENT channel does not suppress (per-channel gate)', async () => {
    const h = build({
      agent: { followup: { enabled: true, afterHours: 24, maxFollowups: 3 } },
      channel: { type: 'WHATSAPP' },
    });
    h.prisma.lead.findFirst.mockResolvedValue({
      businessName: 'Acme', contactPerson: 'Ayşe', waOptOut: false, emailOptOut: true,
    });
    await (h.engine as any).handleFollowupJob({ payload: { workspaceId: WS, conversationId: CONVO } });
    expect(h.sender.send).toHaveBeenCalledTimes(1);
  });

  // A post-send bookkeeping throw must NOT propagate: the runner would retry
  // the job, the un-persisted followupCount would pass the guard again, and
  // the customer would get a DUPLICATE nudge (+ a second credit).
  it('proactive follow-up: a post-send bookkeeping failure is swallowed (no retry → no duplicate nudge)', async () => {
    const h = build({
      agent: { followup: { enabled: true, afterHours: 24, maxFollowups: 3 } },
      channel: { type: 'WHATSAPP' },
    });
    h.prisma.lead.findFirst.mockResolvedValue({ businessName: 'Acme', contactPerson: 'Ayşe' });
    h.prisma.conversation.update.mockRejectedValue(new Error('db blip after send'));
    await expect(
      (h.engine as any).handleFollowupJob({ payload: { workspaceId: WS, conversationId: CONVO } }),
    ).resolves.toBeUndefined();
    // The message went out exactly once and, because it WAS sent, no refund.
    expect(h.sender.send).toHaveBeenCalledTimes(1);
    expect(h.credits.refund).not.toHaveBeenCalled();
  });

  it('happy path: claims a daily slot atomically, sends one AI reply, meters a credit', async () => {
    const h = build();
    await run(h);
    expect(h.credits.reserveForJob).toHaveBeenCalledTimes(1);
    // The daily-reply cap is now an atomic conditional UPDATE (one claim).
    expect(h.prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(h.sender.send).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, conversationId: CONVO, authorType: 'AI' }),
    );
    // No post-send read-modify-write counter bump remains. The one write left
    // on this path clears the "AI did not respond" banner, which is the point
    // of it — nothing reads or increments anything.
    expect(h.prisma.conversation.update.mock.calls.map((c: any[]) => c[0].data)).toEqual([
      { aiLastDeclineReason: null, aiLastDeclineAt: null },
    ]);
    expect(h.credits.refund).not.toHaveBeenCalled();
  });

  // Brand Brain: the compact brand block, when present, must be grounded into
  // the system prompt sent to the model — customer-facing replies should be
  // consistent with the workspace's brand profile.
  it('brand block: when BrandContextService returns a block, the system prompt sent to Claude contains it', async () => {
    const h = build();
    h.brandContext.summaryFor.mockResolvedValue('Brand: Acme\nWe sell X.');
    await run(h);
    const system = h.anthropic.complete.mock.calls[0][0].system as string;
    expect(system).toContain('About this brand');
    expect(system).toContain('Brand: Acme\nWe sell X.');
  });

  it('brand block: when BrandContextService returns null (default), the system prompt has no brand section', async () => {
    const h = build();
    await run(h);
    const system = h.anthropic.complete.mock.calls[0][0].system as string;
    expect(system).not.toContain('About this brand');
  });

  it('gate: a human-paused conversation gets no AI reply', async () => {
    const h = build({ convo: { aiPaused: true } });
    await run(h);
    expect(h.sender.send).not.toHaveBeenCalled();
    expect(h.credits.reserveForJob).not.toHaveBeenCalled();
  });

  it('records WHY it stayed silent ON the conversation, not only in the server log', async () => {
    // `decline()` already names every gate it closes — but only to the log. The
    // person who can actually act on it (attach an agent, resume the thread) is
    // looking at the inbox, where nothing said anything at all. On one workspace
    // that cost four customers a month of silence before anyone read the source.
    const h = build({ convo: { aiPaused: true } });
    await run(h);
    const write = h.prisma.conversation.update.mock.calls.find(
      (c: any) => c[0]?.data?.aiLastDeclineReason !== undefined,
    );
    expect(write?.[0]).toMatchObject({
      where: { id: CONVO },
      data: {
        aiLastDeclineReason: expect.stringMatching(/paused/i),
        aiLastDeclineAt: expect.any(Date),
      },
    });
  });

  it('a decline it cannot write down still declines cleanly', async () => {
    // The record is the story, not the transaction. The engine has already
    // decided not to answer; a failed write must not turn that decision into a
    // throw on a job the runner would then retry forever.
    const h = build({ convo: { aiPaused: true } });
    h.prisma.conversation.update.mockRejectedValue(new Error('db down'));
    await expect(run(h)).resolves.toBeUndefined();
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it('…and survives a write that throws on the spot, not only one that rejects', async () => {
    // The test above passed while the property it describes was NOT guaranteed:
    // a `.catch()` handles a rejected promise, never a synchronous throw from
    // the call itself. The suite found the difference — a second engine harness
    // in this same file builds a leaner prisma double with no
    // `conversation.update` at all, so the call threw on the spot and took six
    // unrelated tests down with it.
    const h = build({ convo: { aiPaused: true } });
    h.prisma.conversation.update.mockImplementation(() => {
      throw new TypeError('update is not a function');
    });
    await expect(run(h)).resolves.toBeUndefined();
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it('gate: no agent attached to the channel → no reply', async () => {
    const h = build({ channel: { agentProfileId: null } });
    await run(h);
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it('gate: per-conversation daily reply cap reached → atomic claim returns 0, no reply, no credit', async () => {
    const h = build({ claimed: 0, agent: { maxRepliesPerConvoDaily: 30 } });
    await run(h);
    expect(h.prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(h.sender.send).not.toHaveBeenCalled();
    // The claim was rejected before reserving a credit.
    expect(h.credits.reserveForJob).not.toHaveBeenCalled();
  });

  // Every frame this engine pushes lands on the whole-workspace stream that the
  // person surface reads. Unnamed, each one costs that surface a refetch of
  // whoever happens to be open — the AI typing on somebody else's thread is the
  // single chattiest source of those.
  it('names the person on the typing frames it brackets a reply with', async () => {
    const h = build();
    await run(h);
    const typing = h.stream.push.mock.calls.filter((c: any[]) => c[1].kind === 'ai_typing');
    expect(typing).toHaveLength(2);
    expect(typing.map((c: any[]) => c[1].leadId)).toEqual(['lead-1', 'lead-1']);
  });

  it('names the person on the handoff frame', async () => {
    const h = build({
      agent: { handoffRules: { keywords: ['human'] } },
      history: [{ direction: 'INBOUND', body: 'I want a human please' }],
    });
    await run(h);
    expect(h.stream.push).toHaveBeenCalledWith(
      WS,
      expect.objectContaining({ kind: 'conversation', conversationId: CONVO, leadId: 'lead-1' }),
    );
  });

  it('gate: AI disabled (no key) → no reply, no credit', async () => {
    const h = build({ enabled: false });
    await run(h);
    expect(h.sender.send).not.toHaveBeenCalled();
    expect(h.credits.reserveForJob).not.toHaveBeenCalled();
  });

  it('handoff tool pauses the AI, sends nothing, and refunds the credit', async () => {
    const h = build({
      complete: {
        text: '',
        toolUses: [{ type: 'tool_use', id: 't1', name: 'request_human_handoff', input: { reason: 'angry' } }],
        stopReason: 'tool_use',
        usage: { input: 1, output: 1 },
      },
    });
    await run(h);
    expect(h.sender.send).not.toHaveBeenCalled();
    expect(h.credits.refund).toHaveBeenCalledTimes(1);
    expect(h.prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ aiPaused: true }) }),
    );
  });

  it('handoff keyword in an EARLIER unanswered inbound (not just the latest) escalates before claiming a slot', async () => {
    // Burst since the last OUTBOUND: the keyword is in the first inbound, the
    // latest inbound is innocuous — the whole burst must still be scanned.
    const h = build({
      agent: { handoffRules: { keywords: ['human'] } },
      // findMany is ordered createdAt DESC (newest first); the service reverses
      // it to chronological. So provide newest-first here: the innocuous reply
      // is most recent, the handoff word is the earlier unanswered inbound.
      history: [
        { direction: 'INBOUND', body: 'thanks' },
        { direction: 'INBOUND', body: 'I want a human please' },
        { direction: 'OUTBOUND', body: 'How can I help?' },
      ],
    });
    await run(h);
    expect(h.prisma.conversation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ aiPaused: true }) }),
    );
    expect(h.sender.send).not.toHaveBeenCalled();
    // Escalation happens BEFORE the slot claim / credit reserve.
    expect(h.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(h.credits.reserveForJob).not.toHaveBeenCalled();
  });

  // --- BUG 1 REGRESSION: scheduleFollowup throws after send() succeeds ---
  it('BUG 1: scheduleFollowup rejection after a successful send does NOT throw; reply sent exactly once, credit NOT refunded', async () => {
    const h = build({
      agent: { followup: { enabled: true, afterHours: 24, maxFollowups: 3 } },
    });
    // Make scheduleFollowup's underlying scheduledJobs.schedule reject.
    h.scheduledJobs.schedule.mockRejectedValue(new Error('DB connection lost'));

    // reply() must resolve (not throw) even though scheduleFollowup fails.
    await expect(run(h)).resolves.toBeUndefined();

    // The message was sent exactly once.
    expect(h.sender.send).toHaveBeenCalledTimes(1);
    // The credit must NOT be refunded (sent = true, so the finally branch is skipped).
    expect(h.credits.refund).not.toHaveBeenCalled();
  });

  // --- BUG 2 REGRESSION: credit reserve throws → slot must be released ---
  it('BUG 2: credits.reserveForJob() exhaustion after slot claimed → slot released, no send', async () => {
    const { ForbiddenException } = await import('@nestjs/common');
    const h = build();
    // credits.reserveForJob throws the exhausted error AFTER the slot was claimed
    // (claimed returns 1 from $executeRaw mock).
    h.credits.reserveForJob.mockRejectedValue(new ForbiddenException({ code: 'AI_CREDITS_EXHAUSTED' }));

    // reply() throws (the ForbiddenException re-propagates since it's not the
    // scheduleFollowup path — but the finally must still release the slot).
    await expect(run(h)).rejects.toBeDefined();

    // The slot was claimed (1 call for the conditional UPDATE).
    expect(h.prisma.$executeRaw).toHaveBeenCalledTimes(2); // 1 claim + 1 release
    // No message sent.
    expect(h.sender.send).not.toHaveBeenCalled();
    // The credit refund is NOT called since no charge receipt was returned.
    expect(h.credits.refund).not.toHaveBeenCalled();
  });

  // --- BUG 9 REGRESSION: tool loop exhausts all iterations on tool_use ---
  it('BUG 9: tool_use on final iteration → final no-tools completion called; its text is returned', async () => {
    // complete() returns tool_use on every tool-bearing call, then text on the
    // final no-tools call.
    const toolUseResponse = {
      text: '',
      toolUses: [{ type: 'tool_use', id: 't1', name: 'capture_lead_fields', input: { name: 'Ali' } }],
      stopReason: 'tool_use',
      usage: { input: 1, output: 1 },
    };
    const finalTextResponse = {
      text: 'Great, I have saved your details!',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1 },
    };

    let callCount = 0;
    const h = build({
      complete: undefined, // we'll override per-call below
    });
    // Prisma lead mock for captureLeadFields (called during tool execution)
    h.prisma.lead = {
      findFirst: jest.fn().mockResolvedValue({ contactPerson: null, email: null, phone: null, city: null, notes: null }),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({}),
    };
    h.anthropic.complete.mockImplementation(() => {
      callCount++;
      // The first MAX_TOOL_ITERATIONS calls always return tool_use (exhausting the loop).
      // The final call (no tools param) returns text.
      if (callCount <= 3) return Promise.resolve(toolUseResponse);
      return Promise.resolve(finalTextResponse);
    });

    await run(h);

    // 3 tool-bearing calls + 1 final no-tools call.
    expect(h.anthropic.complete).toHaveBeenCalledTimes(4);
    // The final no-tools call must NOT include a `tools` key.
    const lastCall = h.anthropic.complete.mock.calls[3][0];
    expect(lastCall.tools).toBeUndefined();
    // The text from the final call was sent.
    expect(h.sender.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Great, I have saved your details!' }),
    );
  });

  it('BUG 9b: a tool_use WITH preamble text on the final iteration still forces a final completion (ships the answer, not the preamble)', async () => {
    // The old guard was `if (!finalText)`, so a last tool turn that ALSO carried
    // preamble text left finalText non-empty and skipped the final completion —
    // shipping "Let me save that…" as the reply instead of the real answer.
    const toolUseWithPreamble = {
      text: 'Let me save that and check for you…', // preamble alongside the tool call
      toolUses: [{ type: 'tool_use', id: 't1', name: 'capture_lead_fields', input: { name: 'Ali' } }],
      stopReason: 'tool_use',
      usage: { input: 1, output: 1 },
    };
    const finalTextResponse = {
      text: 'Your table is booked for 8pm.',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { input: 1, output: 1 },
    };

    let callCount = 0;
    const h = build({ complete: undefined });
    h.prisma.lead = {
      findFirst: jest.fn().mockResolvedValue({ contactPerson: null, email: null, phone: null, city: null, notes: null }),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({}),
    };
    h.anthropic.complete.mockImplementation(() => {
      callCount++;
      if (callCount <= 3) return Promise.resolve(toolUseWithPreamble);
      return Promise.resolve(finalTextResponse);
    });

    await run(h);

    expect(h.anthropic.complete).toHaveBeenCalledTimes(4); // 3 tool turns + 1 final
    expect(h.anthropic.complete.mock.calls[3][0].tools).toBeUndefined();
    expect(h.sender.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Your table is booked for 8pm.' }),
    );
    expect(h.sender.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Let me save that and check for you…' }),
    );
  });

  // Regression: a captured email/phone must also write the NORMALIZED keys —
  // every dedup path matches on emailNormalized/phoneNormalized, so a raw-only
  // capture leaves the lead invisible to dedup and spawns duplicates.
  it('capture_lead_fields writes the normalized email/phone keys, not just the raw values', async () => {
    const captureResponse = {
      text: '',
      toolUses: [{
        type: 'tool_use', id: 't1', name: 'capture_lead_fields',
        input: { email: 'Test@X.com', phone: '+90 555 111 22 33' },
      }],
      stopReason: 'tool_use',
      usage: { input: 1, output: 1 },
    };
    const finalText = { text: 'Saved!', toolUses: [], stopReason: 'end_turn', usage: { input: 1, output: 1 } };
    const h = build();
    h.prisma.lead = {
      findFirst: jest.fn().mockResolvedValue({ contactPerson: null, email: null, phone: null, city: null, notes: null }),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({}),
    };
    let n = 0;
    h.anthropic.complete.mockImplementation(() => Promise.resolve(++n === 1 ? captureResponse : finalText));

    await run(h);

    const data = h.prisma.lead.updateMany.mock.calls[0][0].data;
    expect(data.email).toBe('Test@X.com');
    expect(data.emailNormalized).toBe('test@x.com');
    expect(data.phone).toBe('+90 555 111 22 33');
    expect(data.phoneNormalized).toBe('905551112233');
  });

  /**
   * `AgentProfile.captureFields` was stored by the panel and NEVER read by the
   * engine — dead configuration. The consequence showed up live: every web-chat
   * thread produced a lead named "Web chat contact / Unknown" with no phone or
   * email, which nothing downstream (call, email, convert) can act on.
   */
  describe('configured capture fields', () => {
    it('tells the agent what is still missing, and not what the lead already has', async () => {
      const h = build({ agent: { captureFields: ['name', 'phone', 'email'] } });
      // The lead already has a contactPerson (the default fixture) but no phone/email.
      await run(h);
  
      const system = h.anthropic.complete.mock.calls[0][0].system as string;
      expect(system).toContain('Still needed from this customer');
      expect(system).toContain('phone');
      expect(system).toContain('email');
      // Tied to buying intent + placed at the end of the reply: a soft
      // "where it fits naturally" was read as permission to defer forever.
      expect(system).toContain('real buying intent');
      expect(system).toContain('One field per turn');
      // Already known — re-asking reads as not listening.
      expect(system).not.toMatch(/Still needed from this customer:[^\n]*name/);
    });
  
    it('says nothing when every configured field is already known', async () => {
      const h = build({ agent: { captureFields: ['name'] } });
      await run(h);
      const system = h.anthropic.complete.mock.calls[0][0].system as string;
      expect(system).not.toContain('Still needed from this customer');
    });
  
    it('says nothing when the agent has no captureFields configured (unchanged behaviour)', async () => {
      const h = build();
      await run(h);
      const system = h.anthropic.complete.mock.calls[0][0].system as string;
      expect(system).not.toContain('Still needed from this customer');
      // The always-on instruction stays: capture what is volunteered.
      expect(system).toContain('capture_lead_fields');
    });
  });

  /**
   * Why the AI stayed silent.
   *
   * Every gate in reply() used to be a bare `return`, so an engine that
   * declined every message was indistinguishable from an engine nobody had
   * messaged. On a live workspace `conversation.reply` had never been recorded
   * once in 30 days of AI usage — four customers waiting since June — and
   * working out WHICH gate closed meant reading the source and guessing,
   * because nothing had written the reason down anywhere.
   */
  describe('declines say why', () => {
    const runDecline = async (overrides: any) => {
      const h = build(overrides);
      const logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
      (h.engine as any).logger = logger;
      await (h.engine as any).reply(WS, CONVO);
      return logger.log.mock.calls.map((c: any[]) => String(c[0])).join(' | ');
    };

    it('names the gate when the conversation is closed', async () => {
      expect(await runDecline({ convo: { status: 'CLOSED' } })).toMatch(/not OPEN/);
    });

    it('distinguishes a human takeover from a closed thread', async () => {
      // Two very different situations that both used to produce silence.
      expect(await runDecline({ convo: { aiPaused: true } })).toMatch(/AI paused/);
    });

    it('will not answer for a lead the business has deleted', async () => {
      // The ingress withholds the inbound EVENT for a hidden lead, but this
      // lane is also reached by the hourly backfill sweep, the connector's
      // claimed job and a manual re-run. Answering as the business to a record
      // the business has hidden is the same defect through a different door.
      expect(
        await runDecline({ lead: { businessName: 'Acme', deletedAt: new Date() } }),
      ).toMatch(/deleted or merged/);
    });

    it('will not answer on a thread whose lead was merged away', async () => {
      expect(
        await runDecline({ lead: { businessName: 'Acme', mergedIntoId: 'lead-9' } }),
      ).toMatch(/deleted or merged/);
    });

    it('names the channel when no agent is attached', async () => {
      expect(await runDecline({ channel: { agentProfileId: null } })).toMatch(
        /no agent profile attached/,
      );
    });

    it('says so when the agent profile is not active', async () => {
      expect(await runDecline({ agent: { status: 'PAUSED' } })).toMatch(/not ACTIVE/);
    });

    it('says so when Anthropic is unconfigured', async () => {
      expect(await runDecline({ enabled: false })).toMatch(/no usable AI key for this workspace/);
    });

    it('reports the cap it hit, with the number', async () => {
      // "hit the cap" without the cap is half an answer.
      expect(await runDecline({ claimed: 0 })).toMatch(/daily reply cap reached/);
    });
  });

  /**
   * A reply the channel refused is not a reply.
   *
   * MessageSenderService does NOT throw when a provider rejects a message: it
   * refunds the channel quota, logs, persists the row as FAILED and returns
   * normally. The engine set `sent = true` regardless, which meant a rejected
   * reply skipped the credit refund AND the daily-slot release, and still
   * scheduled a proactive follow-up.
   *
   * So the customer got nothing, the workspace paid a credit, one of the day's
   * replies was burned, and a nudge was queued for a conversation that had never
   * been answered — all of it silent apart from one warn line inside the sender.
   *
   * On web chat a send effectively cannot fail. On the Meta channels it can and
   * does: outside the 24-hour window, a revoked page token, a rejected template.
   * Those are the channels the AI is about to start answering on.
   */
  describe('ConversationAiEngineService.reply — the channel refuses the send', () => {
    const WS2 = 'ws-1';
    const CONVO2 = 'convo-1';

    it('refunds the credit and releases the daily slot', async () => {
      const h = build({ sendStatus: 'FAILED' });
      await (h.engine as never as { reply: (w: string, c: string) => Promise<void> }).reply(WS2, CONVO2);

      expect(h.sender.send).toHaveBeenCalled();
      expect(h.credits.refund).toHaveBeenCalled();
      // The slot release is the conditional UPDATE in the finally block.
      const releases = (h.prisma.$executeRaw as jest.Mock).mock.calls.filter((c) =>
        String(c[0]).includes('GREATEST'),
      );
      expect(releases.length).toBe(1);
    });

    it('does NOT schedule a follow-up for a reply nobody received', async () => {
      const h = build({ sendStatus: 'FAILED' });
      await (h.engine as never as { reply: (w: string, c: string) => Promise<void> }).reply(WS2, CONVO2);

      // A nudge on top of silence reads as a second unanswered message.
      expect(h.scheduledJobs.schedule).not.toHaveBeenCalled();
    });

    it('keeps the credit and schedules the follow-up when the send DID go', async () => {
      const h = build({ sendStatus: 'SENT' });
      await (h.engine as never as { reply: (w: string, c: string) => Promise<void> }).reply(WS2, CONVO2);

      expect(h.credits.refund).not.toHaveBeenCalled();
      // And the slot STAYS claimed: the reply really did use one of the day's.
      const releases = (h.prisma.$executeRaw as jest.Mock).mock.calls.filter((c) =>
        String(c[0]).includes('GREATEST'),
      );
      expect(releases).toHaveLength(0);
    });
  });

  /**
   * The anti-invention instruction must not depend on having a knowledge base.
   *
   * It used to live inside the `if (kb.length)` block, so the strongest line in
   * the whole prompt appeared only when the grounding was already good and
   * vanished when it was thinnest. The live workspace has an EMPTY kbDocIds, so
   * on every real conversation it was absent — and this brand's entire pitch is
   * that there are no traps and no hidden tiers, with an objection list opening
   * on "if it's free, will you charge me later?".
   */
  describe('ConversationAiEngineService.buildSystem — never invent', () => {
    const systemFor = async (overrides: Parameters<typeof build>[0] = {}) => {
      const h = build(overrides);
      await (h.engine as never as { reply: (w: string, c: string) => Promise<void> }).reply(
        'ws-1',
        'convo-1',
      );
      return String((h.anthropic.complete as jest.Mock).mock.calls[0][0].system);
    };

    it('tells the model not to invent, with no knowledge base at all', async () => {
      const system = await systemFor();

      expect(system).toMatch(/Never invent facts/);
      expect(system).toMatch(/prices/);
    });

    it('still says it when a knowledge base IS present', async () => {
      const system = await systemFor();

      // The instruction is unconditional; the KB block only adds grounding.
      expect(system).toMatch(/Never invent facts/);
    });

    it('keeps the brand block, which is where the price list arrives', async () => {
      const h = build();
      (h.brandContext.summaryFor as jest.Mock).mockResolvedValue(
        ['Brand: HummyTummy', 'Offerings (name — price — what it is):', '- Ek Şube — 3.990₺/yıl'].join(
          String.fromCharCode(10),
        ),
      );
      await (h.engine as never as { reply: (w: string, c: string) => Promise<void> }).reply(
        'ws-1',
        'convo-1',
      );
      const system = String((h.anthropic.complete as jest.Mock).mock.calls[0][0].system);

      expect(system).toContain('Ek Şube — 3.990₺/yıl');
      expect(system).toMatch(/ground every reply in this/i);
    });
  });

  /**
   * The customer's name, once given, has to land.
   *
   * captureLeadFields fills only EMPTY contact fields — right, so the model
   * cannot overwrite something a human corrected. But web-chat ingress opens
   * every lead with contactPerson "Unknown", and "Unknown" is not an empty
   * string. So the agent asked for a name (it is in captureFields), the
   * customer gave it, the model called capture_lead_fields, and the write was
   * silently skipped. The lead stayed "Web chat contact / Unknown" — the exact
   * state buildSystem's own comment complains about, and a lead the rest of the
   * product cannot call, email or convert.
   */
  describe('ConversationAiEngineService.captureLeadFields — the Unknown placeholder', () => {
    const capture = async (existing: string | null, given = 'Ayşe Yılmaz') => {
      const h = build({
        complete: {
          text: '',
          toolUses: [{ id: 't1', name: 'capture_lead_fields', input: { name: given } }],
          stopReason: 'tool_use',
          usage: { input: 1, output: 1 },
        },
      });
      (h.prisma.lead as unknown as { updateMany: jest.Mock }).updateMany = jest
        .fn()
        .mockResolvedValue({ count: 1 });
      (h.prisma.lead.findFirst as jest.Mock).mockResolvedValue({
        contactPerson: existing,
        email: null,
        phone: null,
        city: null,
        notes: null,
      });
      await (h.engine as never as { reply: (w: string, c: string) => Promise<void> }).reply(
        'ws-1',
        'convo-1',
      );
      const calls = (h.prisma.lead.updateMany as jest.Mock).mock.calls;
      return calls.length ? calls[0][0].data : null;
    };

    it('writes the real name over the ingress placeholder', async () => {
      expect(await capture('Unknown')).toMatchObject({ contactPerson: 'Ayşe Yılmaz' });
    });

    it('treats the placeholder case- and space-insensitively', async () => {
      expect(await capture('  unknown ')).toMatchObject({ contactPerson: 'Ayşe Yılmaz' });
    });

    it('still writes when the field is genuinely empty', async () => {
      expect(await capture(null)).toMatchObject({ contactPerson: 'Ayşe Yılmaz' });
    });

    it('does NOT overwrite a real name a human may have corrected', async () => {
      const data = await capture('Mehmet Demir');
      expect(data?.contactPerson).toBeUndefined();
    });
  });

  /**
   * THE OUTBOUND OPENER.
   *
   * The Messages API needs a leading USER turn, so `buildHistory` shifts any
   * outbound turns off the front — and threw the text away. On every
   * outbound-first thread (a campaign, a distribution mail, `jeeta_send_message`)
   * that is the whole context: the customer answers "Evet, detayları gönderir
   * misiniz?" and the model has never seen the offer they are answering.
   */
  describe('the outbound opener the model was answering', () => {
    // A fresh array per test: the service reverses the rows findMany hands it,
    // in place, so a shared fixture would arrive the other way round.
    const openerHistory = () => [
      // findMany is DESC (newest first); the service reverses it.
      { direction: 'INBOUND', body: 'Evet, detayları gönderir misiniz?' },
      { direction: 'OUTBOUND', body: 'Merhaba, size %20 indirimli bir paket hazırladık.' },
    ];

    it('is folded into the system prompt, as OUR copy', async () => {
      const h = build({ history: openerHistory() });
      await run(h);
      const call = h.anthropic.complete.mock.calls[0][0];
      expect(call.system).toContain('%20 indirimli bir paket');
      // …and as our own words, not as a customer turn: the system prompt
      // declares every user turn untrusted, so folding our offer in there would
      // let the model conclude the CUSTOMER proposed it.
      expect(JSON.stringify(call.messages)).not.toContain('%20 indirimli');
      expect(call.messages[0].role).toBe('user');
    });

    it('the follow-up prompt sees it too — that is the turn told not to repeat it', async () => {
      const h = build({
        history: openerHistory(),
        agent: { followup: { enabled: true, afterHours: 24, maxFollowups: 3 } },
      });
      await (h.engine as any).handleFollowupJob({ payload: { workspaceId: WS, conversationId: CONVO } });
      expect(h.anthropic.complete.mock.calls[0][0].system).toContain('%20 indirimli bir paket');
    });

    it('an outbound-only thread says the customer has not replied, not that they opened it', async () => {
      const h = build({ history: [{ direction: 'OUTBOUND', body: 'Merhaba, bir teklifimiz var.' }] });
      await run(h);
      const call = h.anthropic.complete.mock.calls[0][0];
      expect(call.messages[0].content).toMatch(/has not replied/i);
      expect(call.system).toContain('bir teklifimiz var');
    });

    it('a send the provider REFUSED is not history — the model must re-answer the question', async () => {
      const h = build({
        history: [
          { direction: 'INBOUND', body: 'Fiyat nedir?' },
          { direction: 'OUTBOUND', body: 'Bu asla gitmedi', status: 'FAILED' },
        ],
      });
      await run(h);
      const call = h.anthropic.complete.mock.calls[0][0];
      expect(JSON.stringify(call.messages)).not.toContain('asla gitmedi');
      expect(call.system).not.toContain('asla gitmedi');
    });
  });

  /**
   * A 4xx / timeout is not a final answer.
   *
   * `MessageSenderService` persists a FAILED row and returns normally, so a
   * relay that blinked cost the customer their answer for good. The retry is
   * BOUNDED: one more attempt, then the decline stands.
   */
  describe('a transient refusal reschedules — once', () => {
    it('reschedules the reply when the dispatcher says the failure was transient', async () => {
      const h = build({ sendStatus: 'FAILED', sendRetriable: true });
      await run(h);
      const retries = h.scheduledJobs.schedule.mock.calls.filter(
        (c: any[]) => c[0]?.payload?.sendRetry === 1,
      );
      expect(retries).toHaveLength(1);
      expect(retries[0][0].dedupKey).toBe(CONVO);
      expect(retries[0][0].runAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('…and only once: the retry that fails again is final', async () => {
      const h = build({ sendStatus: 'FAILED', sendRetriable: true });
      await (h.engine as any).handleAiReplyJob({
        payload: { workspaceId: WS, conversationId: CONVO, sendRetry: 1 },
      });
      expect(h.scheduledJobs.schedule).not.toHaveBeenCalled();
    });

    it('a PERMANENT refusal is still final (unchanged behaviour)', async () => {
      const h = build({ sendStatus: 'FAILED', sendRetriable: false });
      await run(h);
      expect(h.scheduledJobs.schedule).not.toHaveBeenCalled();
    });
  });

  /**
   * An exhausted message allowance used to cost SIX Claude runs per inbound:
   * the send threw MESSAGES_EXHAUSTED out of the engine, onInbound rescheduled,
   * and the runner retried five times — each one generating a fresh reply
   * nobody could ever receive.
   */
  describe('the monthly message allowance', () => {
    it('costs ZERO model calls when it is already spent', async () => {
      const h = build({ usage: { limit: 500, used: 500, remaining: 0 } });
      await run(h);
      expect(h.anthropic.complete).not.toHaveBeenCalled();
      expect(h.credits.reserveForJob).not.toHaveBeenCalled();
      expect(h.sender.send).not.toHaveBeenCalled();
      const write = h.prisma.conversation.update.mock.calls.find(
        (c: any) => c[0]?.data?.aiLastDeclineReason !== undefined,
      );
      expect(write?.[0].data.aiLastDeclineReason).toMatch(/allowance/i);
    });

    it('never gates WEB CHAT, which reserves nothing', async () => {
      // The sibling path the obvious fix breaks: an unmetered channel would
      // otherwise go silent the moment the pool ran dry.
      const h = build({ metered: false, usage: { limit: 500, used: 500, remaining: 0 } });
      await run(h);
      expect(h.sender.send).toHaveBeenCalled();
    });

    it('an unlimited plan is not gated', async () => {
      const h = build({ usage: { limit: -1, used: 9999, remaining: -1 } });
      await run(h);
      expect(h.sender.send).toHaveBeenCalled();
    });

    it('a send that races the cap declines instead of escaping the engine', async () => {
      const { ForbiddenException } = await import('@nestjs/common');
      const h = build();
      h.sender.send.mockRejectedValue(
        new ForbiddenException({ code: 'MESSAGES_EXHAUSTED', message: 'Monthly message limit reached (500)' }),
      );
      await expect(run(h)).resolves.toBeUndefined();
      expect(h.credits.refund).toHaveBeenCalled();
      const write = h.prisma.conversation.update.mock.calls.find(
        (c: any) => c[0]?.data?.aiLastDeclineReason !== undefined,
      );
      expect(write?.[0].data.aiLastDeclineReason).toMatch(/allowance/i);
    });

    it('any OTHER send error still escapes — a bookkeeping failure must not be swallowed', async () => {
      const h = build();
      h.sender.send.mockRejectedValue(new Error('message row update failed after the provider accepted'));
      await expect(run(h)).rejects.toThrow(/after the provider accepted/);
    });
  });

  /**
   * The banner said "the AI did not respond" forever, because nothing ever
   * cleared it — and it said it for workspaces that had simply never switched
   * conversation AI on.
   */
  describe('the decline banner', () => {
    it('is cleared the moment a reply DOES go out', async () => {
      const h = build({ convo: { aiLastDeclineReason: 'something old' } });
      await run(h);
      const cleared = h.prisma.conversation.update.mock.calls.find(
        (c: any) => c[0]?.data?.aiLastDeclineReason === null,
      );
      expect(cleared?.[0].data).toMatchObject({ aiLastDeclineReason: null, aiLastDeclineAt: null });
    });

    it('is NOT written for a workspace that never opted into conversation AI', async () => {
      // "no agent profile attached" and "no usable AI key" are configuration,
      // not silence — persisting them puts a permanent red banner on every
      // thread of every tenant who never asked for an AI.
      for (const overrides of [{ channel: { agentProfileId: null } }, { enabled: false }]) {
        const h = build(overrides as any);
        await run(h);
        const write = h.prisma.conversation.update.mock.calls.find(
          (c: any) => c[0]?.data?.aiLastDeclineReason !== undefined,
        );
        expect(write).toBeUndefined();
      }
    });
  });

  /**
   * A handoff used to throw the model's own acknowledgement away, so the
   * customer who asked for a human got silence and no one was told.
   */
  describe('a handoff is visible', () => {
    const handoffRun = async (over: any = {}) => {
      const h = build({
        complete: {
          text: 'Elbette, sizi bir yetkiliye aktarıyorum.',
          toolUses: [{ type: 'tool_use', id: 't1', name: 'request_human_handoff', input: { reason: 'wants a human' } }],
          stopReason: 'tool_use',
          usage: { input: 1, output: 1 },
        },
        ...over,
      });
      await run(h);
      return h;
    };

    it('sends the acknowledgement the model wrote, and still costs nothing', async () => {
      const h = await handoffRun();
      expect(h.sender.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'Elbette, sizi bir yetkiliye aktarıyorum.', authorType: 'AI' }),
      );
      // The escalation is still free: the credit comes back and the daily slot
      // is released, exactly as when the handoff produced no text.
      expect(h.credits.refund).toHaveBeenCalledTimes(1);
    });

    it('writes the reason down and tells the lead’s owner', async () => {
      const h = await handoffRun();
      h.prisma.lead.findFirst.mockResolvedValue({ assignedToId: 'u-1', businessName: 'Acme' });
      expect(h.prisma.conversationNote.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ body: expect.stringContaining('wants a human') }),
        }),
      );
    });

    it('an escalation with nothing to say sends nothing (unchanged)', async () => {
      const h = await handoffRun({ complete: {
        text: '',
        toolUses: [{ type: 'tool_use', id: 't1', name: 'request_human_handoff', input: { reason: 'angry' } }],
        stopReason: 'tool_use',
        usage: { input: 1, output: 1 },
      } });
      expect(h.sender.send).not.toHaveBeenCalled();
    });
  });

  describe('an email reply is written like an email', () => {
    it('is always authored as AI — the flag that gates Auto-Submitted', () => {
      // RFC 3834's `Auto-Submitted: auto-replied` must ride on an automatic
      // reply and NEVER on a human's, or the peer's own auto-reply filter
      // silently drops a rep's answer. The dispatcher derives it from
      // `authorType`, so this engine's half of the contract is to say 'AI' on
      // BOTH of its send paths — and a human reply comes in as 'AGENT' through
      // a different caller entirely.
      const sendCalls = (h: any) => h.sender.send.mock.calls.map((c: any[]) => c[0].authorType);
      return (async () => {
        const reply = build({ channel: { type: 'EMAIL' } });
        await run(reply);
        expect(sendCalls(reply)).toEqual(['AI']);

        const nudge = build({
          channel: { type: 'EMAIL' },
          agent: { followup: { enabled: true, afterHours: 24, maxFollowups: 3 } },
        });
        await (nudge.engine as any).handleFollowupJob({ payload: { workspaceId: WS, conversationId: CONVO } });
        expect(sendCalls(nudge)).toEqual(['AI']);
      })();
    });

    it('gets paragraph structure, not chat register', async () => {
      const h = build({ channel: { type: 'EMAIL' } });
      await run(h);
      const system = h.anthropic.complete.mock.calls[0][0].system as string;
      expect(system).toMatch(/paragraph/i);
      expect(system).not.toMatch(/chat-appropriate/i);
    });

    it('a chat channel keeps its short-reply instruction', async () => {
      const h = build({ channel: { type: 'WEBCHAT' } });
      await run(h);
      expect(h.anthropic.complete.mock.calls[0][0].system).toMatch(/chat-appropriate/i);
    });
  });

  /**
   * capture_lead_fields writes the lead's DEDUP KEYS. On a thread that adopted
   * an existing CRM record, a phone number lifted out of message text is enough
   * to redirect that customer's SMS quotes and merge an attacker's WhatsApp
   * into their lead.
   */
  describe('capture_lead_fields cannot repoint an existing record', () => {
    const captureOn = async (lead: any, input: any) => {
      const h = build({
        convo: { createdAt: new Date('2026-09-20T00:00:00Z') },
        complete: {
          text: '',
          toolUses: [{ type: 'tool_use', id: 't1', name: 'capture_lead_fields', input }],
          stopReason: 'tool_use',
          usage: { input: 1, output: 1 },
        },
      });
      h.prisma.lead.findFirst.mockResolvedValue(lead);
      await run(h);
      const write = h.prisma.lead.updateMany.mock.calls[0];
      return { h, data: write ? write[0].data : null };
    };

    const ADOPTED = {
      contactPerson: 'Mehmet', email: null, phone: null, city: null, notes: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };

    it('a phone in body text does not become the dedup key of an adopted lead', async () => {
      const { h, data } = await captureOn(ADOPTED, { phone: '+90 555 000 11 22' });
      expect(data?.phoneNormalized).toBeUndefined();
      expect(data?.phone).toBeUndefined();
      // …but it is not lost: a rep can read it and promote it by hand.
      expect(h.prisma.leadActivity.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: 'NOTE', description: expect.stringContaining('555 000 11 22') }),
        }),
      );
    });

    it('the conversation’s OWN new lead still gets its keys (the web-chat case)', async () => {
      const { data } = await captureOn(
        { contactPerson: null, email: null, phone: null, city: null, notes: null, createdAt: new Date('2026-09-20T00:00:01Z') },
        { phone: '+90 555 000 11 22' },
      );
      expect(data?.phoneNormalized).toBe('905550001122');
    });

    it('never writes a key another live lead already holds', async () => {
      const h = build({
        convo: { createdAt: new Date('2026-09-20T00:00:00Z') },
        complete: {
          text: '',
          toolUses: [{ type: 'tool_use', id: 't1', name: 'capture_lead_fields', input: { email: 'rakip@x.com' } }],
          stopReason: 'tool_use',
          usage: { input: 1, output: 1 },
        },
      });
      h.prisma.lead.findFirst.mockResolvedValue({
        contactPerson: null, email: null, phone: null, city: null, notes: null,
        createdAt: new Date('2026-09-20T00:00:01Z'),
      });
      h.prisma.lead.count.mockResolvedValue(1);
      await run(h);
      const write = h.prisma.lead.updateMany.mock.calls[0];
      expect(write ? write[0].data.emailNormalized : undefined).toBeUndefined();
    });

    it('never evicts a rep’s own notes to make room for AI text', async () => {
      const { data } = await captureOn(
        { contactPerson: null, email: null, phone: null, city: null, notes: 'x'.repeat(1990), createdAt: null },
        { notes: 'a long captured note that cannot fit under the cap' },
      );
      expect(data?.notes).toBeUndefined();
    });
  });
});

/**
 * MCP FIRST — the platform's Anthropic key is the fallback, never the default.
 *
 * The product is meant to be usable by someone who already has a Claude
 * account: they connect it, the platform carries channels, state, scheduling
 * and sending, and their own Claude does the thinking. So an inbound message
 * under any connector mode must QUEUE, not spend.
 */
describe('ConversationAiEngineService — who does the thinking', () => {
  const WS = 'ws-1';
  const CONVO = 'convo-1';

  function build(
    aiExecution: string | null,
    mcpSeen = false,
    paused = false,
    queuedReplies: any[] = [],
    ownKey = false,
  ) {
    const anthropic = {
      isEnabled: jest.fn().mockReturnValue(true),
      isEnabledFor: jest.fn().mockResolvedValue(true),
      complete: jest.fn(),
    };
    const scheduledJobs = {
      cancel: jest.fn().mockResolvedValue(undefined),
      cancelById: jest.fn().mockResolvedValue(true),
      schedule: jest.fn().mockResolvedValue('job-1'),
    };
    const prisma: any = {
      workspace: {
        findUnique: jest.fn().mockResolvedValue({ aiExecution, aiApiKeyEnc: ownKey ? 'v1:a:b:c' : null }),
      },
      agentRun: { findFirst: jest.fn().mockResolvedValue(mcpSeen ? { id: 'r1' } : null) },
      // A nudge already handed to the connector holds this conversation's slot
      // in the reply queue. The customer writing back has to clear it.
      scheduledJob: { findMany: jest.fn().mockResolvedValue(queuedReplies) },
      // Two callers now: the aiPaused gate before queueing, and reply() on the
      // SERVER path. A null second answer makes reply() decline immediately,
      // which is all these tests need from it.
      conversation: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce(paused ? { aiPaused: true } : { aiPaused: false })
          .mockResolvedValue(null),
      },
    };
    const engine = new ConversationAiEngineService(
      prisma,
      {} as any,
      anthropic as any,
      {} as any,
      {} as any,
      {} as any,
      scheduledJobs as any,
      { registerHandler: jest.fn() } as any,
      { push: jest.fn() } as any,
      {} as any,
      { scheduleNext: jest.fn(), policyFor: jest.fn(() => null) } as any,
    );
    const inbound = (engine as any).onInbound.bind(engine);
    return { engine, prisma, anthropic, scheduledJobs, inbound };
  }

  const event = { payload: { workspaceId: WS, conversationId: CONVO } };

  it('queues instead of spending under MCP', async () => {
    const h = build('MCP');
    await h.inbound(event);
    expect(h.scheduledJobs.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        kind: 'conversation.ai_reply',
        dedupKey: CONVO,
      }),
    );
    // The decisive assertion: reply() never ran, so the platform key was never
    // consulted. Measured on isEnabled() — its very first line — rather than on
    // a conversation read, because the aiPaused gate legitimately reads the
    // conversation before deciding to queue.
    expect(h.anthropic.isEnabled).not.toHaveBeenCalled();
  });

  it('queues under MCP_ONLY too', async () => {
    const h = build('MCP_ONLY');
    await h.inbound(event);
    expect(h.scheduledJobs.schedule).toHaveBeenCalled();
    expect(h.anthropic.isEnabled).not.toHaveBeenCalled();
  });

  it('reads AUTO as the connector only while a Claude is actually connected', async () => {
    const connected = build('AUTO', true);
    await connected.inbound(event);
    expect(connected.scheduledJobs.schedule).toHaveBeenCalled();

    const alone = build('AUTO', false);
    await alone.inbound(event);
    expect(alone.scheduledJobs.schedule).not.toHaveBeenCalled();
    expect(alone.prisma.conversation.findFirst).toHaveBeenCalled();
  });

  it('runs live on SERVER, which is what every workspace had before', async () => {
    const h = build('SERVER');
    await h.inbound(event);
    expect(h.scheduledJobs.schedule).not.toHaveBeenCalled();
    expect(h.prisma.conversation.findFirst).toHaveBeenCalled();
  });

  it('queues for retry without spending when the current policy cannot be read', async () => {
    const h = build('MCP');
    h.prisma.workspace.findUnique.mockRejectedValue(new Error('db down'));
    await h.inbound(event);
    expect(h.scheduledJobs.schedule).toHaveBeenCalledWith(expect.objectContaining({ kind: 'conversation.ai_reply' }));
    expect(h.anthropic.isEnabledFor).not.toHaveBeenCalled();
  });

  it('explicit API overrides legacy MCP_ONLY', async () => {
    const h = build('MCP_ONLY');
    h.prisma.workspace.findUnique.mockResolvedValue({ aiExecution: 'MCP_ONLY', aiSpendPolicy: { jobs: { 'conversation.reply': { provider: 'API' } } } });
    await h.inbound(event);
    expect(h.scheduledJobs.schedule).not.toHaveBeenCalled();
    expect(h.anthropic.isEnabledFor).toHaveBeenCalled();
  });

  it('explicit MCP overrides BYOK and stays strict without a connected client', async () => {
    const h = build('SERVER', false, false, [], true);
    h.prisma.workspace.findUnique.mockResolvedValue({ aiExecution: 'SERVER', aiApiKeyEnc: 'own-key', aiSpendPolicy: { jobs: { 'conversation.reply': { provider: 'MCP' } } } });
    expect(await h.engine.aiModeFor(WS)).toBe('MCP_ONLY');
    await h.inbound(event);
    expect(h.scheduledJobs.schedule).toHaveBeenCalled();
    expect(h.anthropic.isEnabledFor).not.toHaveBeenCalled();
  });

  it('does not enqueue an inbound reply when only follow-ups are enabled', async () => {
    const h = build('MCP');
    h.prisma.workspace.findUnique.mockResolvedValue({ aiExecution: 'MCP', aiSpendPolicy: { jobs: { 'conversation.reply': { enabled: false }, 'conversation.followup': { enabled: true } } } });
    await h.inbound(event);
    expect(h.scheduledJobs.schedule).not.toHaveBeenCalled();
    expect(h.anthropic.isEnabledFor).not.toHaveBeenCalled();
  });

  it('drops a nudge already handed to the connector when the customer writes back', async () => {
    // A queued nudge holds this conversation's dedup slot, so leaving it does
    // BOTH wrong things at once: the customer's actual question cannot queue
    // behind it, and the connector is told to chase someone who is sitting
    // there waiting for an answer.
    const h = build('MCP', false, false, [
      { id: 'nudge-1', payload: { reason: 'followup' } },
    ]);
    await h.inbound(event);
    expect(h.scheduledJobs.cancelById).toHaveBeenCalledWith('nudge-1');
  });

  it('leaves a genuine queued REPLY alone — that is work we still owe', async () => {
    const h = build('MCP', false, false, [{ id: 'reply-1', payload: { reason: 'inbound' } }]);
    await h.inbound(event);
    expect(h.scheduledJobs.cancelById).not.toHaveBeenCalled();
  });

  /**
   * The third writer, and the only instant one.
   *
   * The platform key is one shared account and the connector cannot be woken
   * (MCP is client-to-server, so it must be polled). A key belonging to the
   * workspace is present when the inbound event fires, so the reply is written
   * on that event — no queue, no poll.
   */
  it('answers IN-PROCESS when the workspace brought its own key', async () => {
    const h = build('MCP', false, false, [], true);
    await h.inbound(event);
    expect(h.scheduledJobs.schedule).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'conversation.ai_reply' }),
    );
    // reply() ran: it reads the conversation on its very first line.
    expect(h.prisma.conversation.findFirst).toHaveBeenCalled();
  });

  it('own key beats MCP_ONLY, because MCP_ONLY is a promise about OUR bill', async () => {
    // MCP_ONLY guarantees the PLATFORM key is never spent on this workspace.
    // The workspace's own key is not the platform's, so honouring the promise
    // does not require making the customer wait.
    const h = build('MCP_ONLY', false, false, [], true);
    await h.inbound(event);
    expect(h.scheduledJobs.schedule).not.toHaveBeenCalled();
    expect(h.prisma.conversation.findFirst).toHaveBeenCalled();
  });

  it('without an own key MCP still queues — the lane is unchanged', async () => {
    const h = build('MCP', false, false, [], false);
    await h.inbound(event);
    expect(h.scheduledJobs.schedule).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'conversation.ai_reply' }),
    );
  });

  it('still cancels a pending proactive follow-up before anything else', async () => {
    // The customer just spoke. Whoever ends up answering, the nudge scheduled
    // for their silence is wrong now.
    const h = build('MCP');
    await h.inbound(event);
    expect(h.scheduledJobs.cancel).toHaveBeenCalledWith(expect.any(String), CONVO);
  });

  it('does not queue a thread a human has taken over', async () => {
    // reply() declines on the same flag and the backfill skips it. Queueing
    // anyway would hand the connector work the platform would have refused —
    // the two answerers disagreeing about who is allowed to speak.
    const h = build('MCP', false, true);
    await h.inbound(event);
    expect(h.scheduledJobs.schedule).not.toHaveBeenCalled();
  });
});

/**
 * A conversation becoming a MEETING.
 *
 * The funnel used to stop at "interested": the agent could answer, capture
 * details and escalate, but it could not propose a time — so DEMO_SCHEDULED
 * was reachable only when a person did it by hand. `bookingCalendarId` was
 * stored and snapshotted and read by nothing.
 */
describe('ConversationAiEngineService — booking', () => {
  const WS = 'ws-1';
  const CONVO = 'conv-1';
  const CAL = 'cal-1';

  function build(withCalendar: boolean, over: any = {}) {
    const prisma: any = {
      conversation: { findFirst: jest.fn(async () => ({ leadId: 'lead-1' })) },
      lead: {
        // The THREAD's contact — what the booking must be made for, whatever
        // the model typed into the tool call.
        findFirst: jest.fn(async () =>
          over.lead === undefined
            ? { id: 'lead-1', contactPerson: 'Tarık', email: 'tarik@thread.test', phone: null, status: 'NEW', assignedToId: null, businessName: 'Acme' }
            : over.lead,
        ),
        count: jest.fn(async () => 0),
        updateMany: jest.fn(async () => ({ count: over.claimCount ?? 1 })),
      },
      booking: { findFirst: jest.fn(async () => over.activeBooking ?? null) },
      leadActivity: { create: jest.fn(async () => ({})) },
      marketingUser: { findFirst: jest.fn(async () => ({ id: 'sys-1' })) },
      marketingNotification: { create: jest.fn(async () => ({})) },
    };
    const bookings = {
      availability: jest.fn(async () => over.slots ?? ['2026-09-15T10:00:00.000Z', '2026-09-15T11:00:00.000Z']),
      book: over.bookThrows
        ? jest.fn(async () => { throw new Error('Invalid or past slot'); })
        : jest.fn(async () => ({ id: 'bk-1' })),
      reschedule: jest.fn(async () => ({ id: over.activeBooking?.id ?? 'bk-0' })),
      cancel: jest.fn(async () => ({ id: over.activeBooking?.id ?? 'bk-0' })),
    };
    const outbox = { append: jest.fn(async () => undefined) };
    const svc = new (require('./conversation-ai-engine.service').ConversationAiEngineService)(
      prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      { registerHandler: jest.fn() } as any, {} as any, {} as any, {} as any, bookings as any,
      {} as any, outbox as any,
    );
    return { svc, prisma, bookings, outbox, agent: { id: 'ag-1', bookingCalendarId: withCalendar ? CAL : null } };
  }

  it('offers only real slots, and says so plainly when there are none', async () => {
    // A model told nothing fills the silence with a time it invented, and an
    // invented slot is worse than no offer: the customer writes it down and
    // nobody is there.
    const empty = build(true, { slots: [] });
    const text = await (empty.svc as any).meetingSlots(WS, CAL, {});
    expect(text).toMatch(/do NOT invent/i);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);

    const ok = build(true);
    const listed = await (ok.svc as any).meetingSlots(WS, CAL, {});
    expect(listed).toContain('2026-09-15T10:00:00.000Z');
  });

  it('tells the model NOT to offer a time when the calendar cannot be read', async () => {
    const h = build(true);
    h.bookings.availability.mockRejectedValue(new Error('db down'));
    const text = await (h.svc as any).meetingSlots(WS, CAL, {});
    expect(text).toMatch(/Do NOT offer a time/i);
  });

  it('booking MOVES THE LEAD — the whole point', async () => {
    // A booking that leaves the lead where it was is the exact failure this
    // lane exists to end: something happened and nobody was told.
    const h = build(true);
    const res = await (h.svc as any).bookMeeting(WS, CAL, CONVO, {
      start: '2026-09-15T10:00:00.000Z',
      name: 'Tarık',
    });
    expect(res.failed).toBeUndefined();
    expect(h.prisma.lead.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'lead-1',
          convertedTenantId: null,
          status: { notIn: ['DEMO_SCHEDULED', 'WON', 'LOST'] },
        }),
        data: { status: 'DEMO_SCHEDULED' },
      }),
    );
  });

  it('never drags a closed or converted lead backwards', async () => {
    // The compound WHERE is the guard: a WON lead that books a call again
    // must not be reopened as DEMO_SCHEDULED.
    const h = build(true);
    await (h.svc as any).bookMeeting(WS, CAL, CONVO, { start: '2026-09-15T10:00:00.000Z', name: 'X' });
    const where = h.prisma.lead.updateMany.mock.calls[0][0].where;
    expect(where.status.notIn).toContain('WON');
    expect(where.status.notIn).toContain('LOST');
    expect(where.convertedTenantId).toBeNull();
  });

  it('a lost race comes back as an error that says what to do next', async () => {
    // The slot went while they were deciding. The model must re-offer, not
    // insist on a time that is gone.
    const h = build(true, { bookThrows: true });
    const res = await (h.svc as any).bookMeeting(WS, CAL, CONVO, {
      start: '2020-01-01T10:00:00.000Z',
      name: 'Tarık',
    });
    expect(res.failed).toBe(true);
    expect(res.content).toMatch(/get_meeting_slots again/);
    expect(h.prisma.lead.updateMany).not.toHaveBeenCalled();
  });

  it('refuses to book without a time and a name', async () => {
    const h = build(true);
    const res = await (h.svc as any).bookMeeting(WS, CAL, CONVO, { name: 'Tarık' });
    expect(res.failed).toBe(true);
    expect(h.bookings.book).not.toHaveBeenCalled();
  });

  /**
   * WHOSE booking this is comes from the THREAD, never from the tool call.
   *
   * The model's arguments are downstream of customer text: an injected mail
   * saying "book it for ceo@victim.test" would have minted a lead, mailed a
   * stranger an ICS and left the real customer with nothing.
   */
  describe('identity comes from the thread', () => {
    it('books the thread’s contact, not the model’s', async () => {
      const h = build(true);
      await (h.svc as any).bookMeeting(WS, CAL, CONVO, {
        start: '2026-09-15T10:00:00.000Z',
        name: 'Someone Else',
        email: 'attacker@evil.test',
      });
      expect(h.bookings.book).toHaveBeenCalledWith(WS, CAL, expect.objectContaining({
        email: 'tarik@thread.test',
        name: 'Tarık',
      }));
    });

    it('uses what the model learned only where the record is EMPTY', async () => {
      const h = build(true, { lead: { id: 'lead-1', contactPerson: null, email: null, phone: null, status: 'NEW' } });
      await (h.svc as any).bookMeeting(WS, CAL, CONVO, {
        start: '2026-09-15T10:00:00.000Z',
        name: 'Ayşe',
        email: 'ayse@musteri.test',
      });
      expect(h.bookings.book).toHaveBeenCalledWith(WS, CAL, expect.objectContaining({
        email: 'ayse@musteri.test',
        name: 'Ayşe',
      }));
      // …and it is written back, so the NEXT inbound message dedups here.
      expect(h.prisma.lead.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ emailNormalized: 'ayse@musteri.test' }) }),
      );
    });

    it('never hands the meeting to whoever already owns that address', async () => {
      // book() dedups on emailNormalized. Passing an address another live lead
      // holds would attach THIS customer's appointment to that person — the
      // same key-poisoning the capture path refuses, one call further on.
      const h = build(true, { lead: { id: 'lead-1', contactPerson: null, email: null, phone: null, status: 'NEW' } });
      h.prisma.lead.count.mockResolvedValue(1);
      await (h.svc as any).bookMeeting(WS, CAL, CONVO, {
        start: '2026-09-15T10:00:00.000Z',
        name: 'Ayşe',
        email: 'baskasi@x.test',
      });
      expect(h.bookings.book).toHaveBeenCalledWith(WS, CAL, expect.objectContaining({ email: undefined }));
      expect(h.prisma.lead.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ emailNormalized: 'baskasi@x.test' }) }),
      );
    });

    it('refuses a malformed address rather than booking a meeting nobody is told about', async () => {
      const h = build(true, { lead: { id: 'lead-1', contactPerson: null, email: null, phone: null, status: 'NEW' } });
      const res = await (h.svc as any).bookMeeting(WS, CAL, CONVO, {
        start: '2026-09-15T10:00:00.000Z',
        name: 'Ayşe',
        email: 'ayse at musteri',
      });
      expect(res.failed).toBe(true);
      expect(h.bookings.book).not.toHaveBeenCalled();
    });
  });

  /**
   * "Move it to Thursday" used to ADD a second booking: the first kept its
   * slot, its ICS and its reminder mail, and nobody could see why.
   */
  describe('a change of mind moves the meeting instead of adding one', () => {
    it('reschedules the lead’s live booking on this calendar', async () => {
      const h = build(true, { activeBooking: { id: 'bk-old', startAt: new Date('2026-09-15T10:00:00.000Z') } });
      const res = await (h.svc as any).bookMeeting(WS, CAL, CONVO, {
        start: '2026-09-17T10:00:00.000Z',
        name: 'Tarık',
      });
      expect(res.failed).toBeUndefined();
      expect(h.bookings.reschedule).toHaveBeenCalledWith(WS, 'bk-old', '2026-09-17T10:00:00.000Z');
      expect(h.bookings.book).not.toHaveBeenCalled();
    });

    it('cancel_meeting resolves the booking SERVER-SIDE, never from the model', async () => {
      const h = build(true, { activeBooking: { id: 'bk-old', startAt: new Date('2026-09-15T10:00:00.000Z') } });
      const res = await (h.svc as any).cancelMeeting(WS, CAL, CONVO);
      expect(res.failed).toBeUndefined();
      expect(h.bookings.cancel).toHaveBeenCalledWith(WS, 'bk-old');
      const where = h.prisma.booking.findFirst.mock.calls[0][0].where;
      expect(where).toMatchObject({ workspaceId: WS, calendarId: CAL, leadId: 'lead-1' });
    });

    it('says so plainly when there is nothing to cancel', async () => {
      const h = build(true);
      const res = await (h.svc as any).cancelMeeting(WS, CAL, CONVO);
      expect(res.failed).toBe(true);
      expect(h.bookings.cancel).not.toHaveBeenCalled();
    });
  });

  /**
   * A booking that moves the lead silently breaks every status-driven
   * automation and tells the rep nothing.
   */
  describe('a booking is announced', () => {
    it('writes a timeline row and fires lead.status_changed once per booking', async () => {
      const h = build(true, {
        lead: { id: 'lead-1', contactPerson: 'Tarık', email: 'tarik@thread.test', phone: null, status: 'NEW', assignedToId: 'u-1', businessName: 'Acme' },
      });
      await (h.svc as any).bookMeeting(WS, CAL, CONVO, { start: '2026-09-15T10:00:00.000Z', name: 'Tarık' });
      expect(h.prisma.leadActivity.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ type: 'STATUS_CHANGE', createdById: 'sys-1' }) }),
      );
      expect(h.prisma.marketingNotification.create).toHaveBeenCalled();
      expect(h.outbox.append).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: 'lead-status:lead-1:booking:bk-1',
          payload: expect.objectContaining({ fromStatus: 'NEW', toStatus: 'DEMO_SCHEDULED' }),
        }),
      );
    });

    it('a re-booking on an already-scheduled lead fires no phantom transition', async () => {
      const h = build(true, { claimCount: 0 });
      await (h.svc as any).bookMeeting(WS, CAL, CONVO, { start: '2026-09-15T10:00:00.000Z', name: 'Tarık' });
      expect(h.prisma.leadActivity.create).not.toHaveBeenCalled();
      expect(h.outbox.append).not.toHaveBeenCalled();
    });

    it('a bookkeeping failure never tells the model the slot was refused', async () => {
      // The slot IS reserved by then. Reporting failure makes the AI re-offer a
      // time it already took and mail the customer the wrong one.
      const h = build(true);
      h.prisma.lead.updateMany.mockRejectedValue(new Error('db down'));
      const res = await (h.svc as any).bookMeeting(WS, CAL, CONVO, { start: '2026-09-15T10:00:00.000Z', name: 'Tarık' });
      expect(res.failed).toBeUndefined();
    });
  });
});
