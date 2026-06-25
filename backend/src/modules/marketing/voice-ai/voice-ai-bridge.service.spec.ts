import { VoiceAiBridgeService } from './voice-ai-bridge.service';

function makeDeps() {
  const prisma = {
    agentProfile: { findFirst: jest.fn().mockResolvedValue(null) },
    voiceTranscript: { create: jest.fn().mockResolvedValue({}) },
  };
  const anthropic = {
    complete: jest.fn().mockResolvedValue({
      text: 'Merhaba, size nasıl yardımcı olabilirim?',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { input: 42, output: 11 },
    }),
  };
  const knowledge = { search: jest.fn().mockResolvedValue([]) };
  const credits = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };
  const svc = new VoiceAiBridgeService(prisma as any, anthropic as any, knowledge as any, credits as any);
  return { prisma, anthropic, knowledge, credits, svc };
}

const CHANNEL = { id: 'ch-1', workspaceId: 'ws-1', type: 'VOICE', agentProfileId: 'ap-1', externalId: '+90', configPublic: {} };

const BODY = {
  model: 'gpt-4o-mini',
  messages: [
    { role: 'system', content: 'you are a bot' },
    { role: 'user', content: 'merhaba' },
    { role: 'assistant', content: 'selam' },
    { role: 'user', content: 'fiyat nedir' },
  ],
};

describe('VoiceAiBridgeService', () => {
  it('builds system from AgentProfile persona + guardrails + language and returns OpenAI shape', async () => {
    const { prisma, anthropic, knowledge, credits, svc } = makeDeps();
    prisma.agentProfile.findFirst.mockResolvedValue({
      persona: 'Friendly sales agent',
      tone: 'warm',
      goals: 'close deals',
      guardrails: 'never promise refunds',
      language: 'tr',
      kbDocIds: ['doc-1'],
    });
    knowledge.search.mockResolvedValue([{ id: 'd1', title: 'Pricing', snippet: 'Plan A is 100 TL', rank: 0.9 }]);

    const out = await svc.complete(CHANNEL as any, BODY as any);

    // KB search runs on the LAST user message, with the agent's kbDocIds + limit 3.
    expect(knowledge.search).toHaveBeenCalledWith('ws-1', 'fiyat nedir', ['doc-1'], 3);

    const sys = anthropic.complete.mock.calls[0][0].system as string;
    expect(sys).toContain('Friendly sales agent');
    expect(sys).toContain('never promise refunds');
    expect(sys).toContain('tr');
    expect(sys).toContain('Plan A is 100 TL');

    // Claude opts honored.
    const opts = anthropic.complete.mock.calls[0][0];
    expect(opts.maxTokens).toBe(160);
    expect(opts.tier).toBe('conversation');
    // Prior user/assistant turns mapped (system message dropped).
    expect(opts.messages).toEqual([
      { role: 'user', content: 'merhaba' },
      { role: 'assistant', content: 'selam' },
      { role: 'user', content: 'fiyat nedir' },
    ]);

    // OpenAI completion shape.
    expect(out.object).toBe('chat.completion');
    expect(out.model).toBe('gpt-4o-mini');
    expect(out.choices[0]).toMatchObject({
      index: 0,
      message: { role: 'assistant', content: 'Merhaba, size nasıl yardımcı olabilirim?' },
      finish_reason: 'stop',
    });
    expect(out.usage).toEqual({ prompt_tokens: 42, completion_tokens: 11, total_tokens: 53 });
    expect(typeof out.id).toBe('string');
    expect(typeof out.created).toBe('number');

    expect(credits.reserve).toHaveBeenCalledWith('ws-1', 2);
    expect(credits.refund).not.toHaveBeenCalled();
  });

  it('refunds the credit when Claude throws', async () => {
    const { anthropic, credits, svc } = makeDeps();
    anthropic.complete.mockRejectedValue(new Error('boom'));
    await expect(svc.complete(CHANNEL as any, BODY as any)).rejects.toThrow('boom');
    expect(credits.reserve).toHaveBeenCalledWith('ws-1', 2);
    expect(credits.refund).toHaveBeenCalledWith('ws-1', 2);
  });

  it('works with no AgentProfile and no KB hits (falls back to a default persona)', async () => {
    const { prisma, anthropic, svc } = makeDeps();
    prisma.agentProfile.findFirst.mockResolvedValue(null);
    const out = await svc.complete({ ...CHANNEL, agentProfileId: null } as any, BODY as any);
    expect(out.choices[0].message.content).toBeTruthy();
    const sys = anthropic.complete.mock.calls[0][0].system as string;
    expect(sys.length).toBeGreaterThan(0);
  });

  it('records a VoiceTranscript turn when a callId is derivable, but never fails the response if it errors', async () => {
    const { prisma, svc } = makeDeps();
    prisma.voiceTranscript.create.mockRejectedValue(new Error('db down'));
    const body = { ...BODY, user: 'call-abc' };
    const out = await svc.complete(CHANNEL as any, body as any);
    // Response still produced.
    expect(out.object).toBe('chat.completion');
    // Best-effort write attempted with the derived callId.
    expect(prisma.voiceTranscript.create).toHaveBeenCalled();
  });

  it('does not attempt a transcript write when no callId is derivable', async () => {
    const { prisma, svc } = makeDeps();
    await svc.complete(CHANNEL as any, BODY as any);
    expect(prisma.voiceTranscript.create).not.toHaveBeenCalled();
  });
});
