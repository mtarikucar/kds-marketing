import { ConversationAiEngineService } from './conversation-ai-engine.service';

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
    convo?: any;
    channel?: any;
    agent?: any;
    enabled?: boolean;
    complete?: any;
    history?: any;
    claimed?: number;
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
      conversation: {
        findFirst: jest.fn().mockResolvedValue(convo),
        update: jest.fn().mockResolvedValue({}),
      },
      channel: { findFirst: jest.fn().mockResolvedValue(channel) },
      agentProfile: { findFirst: jest.fn().mockResolvedValue(agent) },
      message: {
        findMany: jest.fn().mockResolvedValue(overrides.history ?? [{ direction: 'INBOUND', body: 'Merhaba' }]),
      },
      lead: { findFirst: jest.fn().mockResolvedValue({ businessName: 'Acme', contactPerson: 'Ayşe' }) },
      // Atomic daily-reply-cap claim: returns rows-affected (1 = slot claimed,
      // 0 = at cap / lost race). Default 1; the cap-hit test overrides to 0.
      $executeRaw: jest.fn().mockResolvedValue(overrides.claimed ?? 1),
    };
    const anthropic = {
      isEnabled: jest.fn().mockReturnValue(overrides.enabled ?? true),
      complete: jest.fn().mockResolvedValue(
        overrides.complete ?? { text: 'Merhaba! Size nasıl yardımcı olabilirim?', toolUses: [], stopReason: 'end_turn', usage: { input: 1, output: 1 } },
      ),
    };
    const credits = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };
    const knowledge = { search: jest.fn().mockResolvedValue([]) };
    const sender = { send: jest.fn().mockResolvedValue({ id: 'out-1' }) };
    const scheduledJobs = { schedule: jest.fn().mockResolvedValue('job'), cancel: jest.fn().mockResolvedValue(true) };
    const runner = { registerHandler: jest.fn() };
    const stream = { push: jest.fn() };
    const engine = new ConversationAiEngineService(
      prisma, {} as any, anthropic as any, credits as any, knowledge as any,
      sender as any, scheduledJobs as any, runner as any, stream as any,
    );
    return { engine, prisma, anthropic, credits, sender, scheduledJobs, stream };
  }

  const run = (h: any) => (h.engine as any).reply(WS, CONVO);

  it('happy path: claims a daily slot atomically, sends one AI reply, meters a credit', async () => {
    const h = build();
    await run(h);
    expect(h.credits.reserve).toHaveBeenCalledTimes(1);
    // The daily-reply cap is now an atomic conditional UPDATE (one claim).
    expect(h.prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(h.sender.send).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WS, conversationId: CONVO, authorType: 'AI' }),
    );
    // No post-send read-modify-write counter bump remains.
    expect(h.prisma.conversation.update).not.toHaveBeenCalled();
    expect(h.credits.refund).not.toHaveBeenCalled();
  });

  it('gate: a human-paused conversation gets no AI reply', async () => {
    const h = build({ convo: { aiPaused: true } });
    await run(h);
    expect(h.sender.send).not.toHaveBeenCalled();
    expect(h.credits.reserve).not.toHaveBeenCalled();
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
    expect(h.credits.reserve).not.toHaveBeenCalled();
  });

  it('gate: AI disabled (no key) → no reply, no credit', async () => {
    const h = build({ enabled: false });
    await run(h);
    expect(h.sender.send).not.toHaveBeenCalled();
    expect(h.credits.reserve).not.toHaveBeenCalled();
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
    expect(h.credits.reserve).not.toHaveBeenCalled();
  });
});
