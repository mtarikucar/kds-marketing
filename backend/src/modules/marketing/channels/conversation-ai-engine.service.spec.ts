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
    expect(h.credits.reserve).not.toHaveBeenCalled();
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
    expect(h.credits.reserve).not.toHaveBeenCalled();
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
  it('BUG 2: credits.reserve() exhaustion after slot claimed → slot released, no send', async () => {
    const { ForbiddenException } = await import('@nestjs/common');
    const h = build();
    // credits.reserve throws the exhausted error AFTER the slot was claimed
    // (claimed returns 1 from $executeRaw mock).
    h.credits.reserve.mockRejectedValue(new ForbiddenException({ code: 'AI_CREDITS_EXHAUSTED' }));

    // reply() throws (the ForbiddenException re-propagates since it's not the
    // scheduleFollowup path — but the finally must still release the slot).
    await expect(run(h)).rejects.toBeDefined();

    // The slot was claimed (1 call for the conditional UPDATE).
    expect(h.prisma.$executeRaw).toHaveBeenCalledTimes(2); // 1 claim + 1 release
    // No message sent.
    expect(h.sender.send).not.toHaveBeenCalled();
    // The credit refund is NOT called since creditReserved=false.
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
});
