import { NotFoundException } from '@nestjs/common';
import { StrategyIntakeService, StrategyIntakeInput } from './strategy-intake.service';

const INPUT: StrategyIntakeInput = {
  url: 'https://acme.example',
  socials: [{ network: 'INSTAGRAM', handle: '@acme' }],
  oneLiner: 'We run a private Metin2 server for a nostalgic community',
};

const toolUse = (id: string, name: string, input: unknown) => ({ id, name, input });
const completion = (toolUses: any[]) => ({ text: '', toolUses, stopReason: 'tool_use', usage: { input: 10, output: 10 } });

function deps(overrides: { aiEnabled?: boolean; completions?: any[]; session?: any } = {}) {
  const complete = jest.fn();
  (overrides.completions ?? []).forEach((c) => complete.mockResolvedValueOnce(c));
  const anthropic = { isEnabled: () => overrides.aiEnabled ?? true, complete };
  const credits = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };

  const created = { id: 'sess1' };
  const store: { current: any } = { current: overrides.session ?? null };
  const prisma = {
    strategyIntakeSession: {
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        store.current = { id: 'sess1', workspaceId: data.workspaceId, status: 'IN_PROGRESS', transcript: {}, autoAnalysis: null };
        return created;
      }),
      update: jest.fn().mockImplementation(async ({ data }: any) => {
        store.current = { ...store.current, ...data };
        return store.current;
      }),
      findFirst: jest.fn().mockImplementation(async () => store.current),
    },
  };
  // Brand-source adapters — inert by default (no live vendors in tests).
  const website = { collect: jest.fn().mockResolvedValue({ source: 'website', status: 'inert', raw: null }) };
  const social = { collect: jest.fn().mockResolvedValue({ source: 'social', status: 'inert', raw: null }) };

  const svc = new StrategyIntakeService(prisma as any, anthropic as any, credits as any, website as any, social as any);
  return { svc, complete, credits, prisma, website, social, store };
}

const analysis = () =>
  completion([toolUse('a1', 'submit_analysis', { product: 'Private MMO server', category: 'gaming', tone: 'playful', suggestedArchetype: 'B2C_COMMUNITY_NICHE' })]);
const ask = (id: string, qs: string[]) => completion([toolUse(id, 'ask_questions', { questions: qs })]);
const done = (id: string) => completion([toolUse(id, 'intake_done', {})]);

describe('StrategyIntakeService', () => {
  describe('start', () => {
    it('gracefully skips when AI is not configured', async () => {
      const { svc, credits } = deps({ aiEnabled: false });
      expect(await svc.start('ws1', INPUT)).toEqual({ skipped: 'ai-not-configured' });
      expect(credits.reserve).not.toHaveBeenCalled();
    });

    it('creates a session, runs auto-analysis, reserves credit, returns first questions', async () => {
      const { svc, complete, credits, prisma, website } = deps({
        completions: [analysis(), ask('q1', ['What is your monthly budget?', 'Who is the core audience?'])],
      });
      const r = await svc.start('ws1', INPUT);

      expect('sessionId' in r && r.sessionId).toBe('sess1');
      expect('questions' in r && r.questions).toEqual(['What is your monthly budget?', 'Who is the core audience?']);
      expect('autoAnalysis' in r && r.autoAnalysis.suggestedArchetype).toBe('B2C_COMMUNITY_NICHE');
      expect(credits.reserve).toHaveBeenCalledWith('ws1', 2);
      expect(complete).toHaveBeenCalledTimes(2); // auto-analysis + first interview turn
      expect(website.collect).toHaveBeenCalled();
      // autoAnalysis + transcript persisted, status still IN_PROGRESS
      const saved = prisma.strategyIntakeSession.update.mock.calls[0][0].data;
      expect(saved.status).toBe('IN_PROGRESS');
      expect(saved.autoAnalysis.product).toBe('Private MMO server');
    });

    it('refunds the reserve if a turn throws', async () => {
      const { svc, credits, complete } = deps({ completions: [analysis()] });
      complete.mockRejectedValueOnce(new Error('anthropic down')); // the interview turn throws
      await expect(svc.start('ws1', INPUT)).rejects.toThrow('anthropic down');
      expect(credits.refund).toHaveBeenCalledWith('ws1', 2);
    });
  });

  describe('answer', () => {
    it('advances the loop and returns the next questions', async () => {
      const { svc } = deps({
        completions: [analysis(), ask('q1', ['Budget?']), ask('q2', ['Top competitors?'])],
      });
      await svc.start('ws1', INPUT);
      const r = await svc.answer('ws1', 'sess1', ['$500/mo']);
      expect(r).toEqual({ questions: ['Top competitors?'] });
    });

    it('returns { done: true } when the model calls intake_done', async () => {
      const { svc, credits } = deps({
        completions: [analysis(), ask('q1', ['Budget?']), done('d1')],
      });
      await svc.start('ws1', INPUT);
      const r = await svc.answer('ws1', 'sess1', ['$500/mo']);
      expect(r).toEqual({ done: true });
      expect(credits.reserve).toHaveBeenCalledTimes(2); // start + this answer turn
    });

    it('throws NotFound for an unknown session', async () => {
      const { svc } = deps({ completions: [], session: null });
      await expect(svc.answer('ws1', 'nope', ['x'])).rejects.toThrow(NotFoundException);
    });

    it('respects the turn cap — terminates with done without exceeding MAX turns', async () => {
      // Model never volunteers intake_done; the cap must end the interview.
      const completions = [analysis(), ask('q1', ['a?']), ask('q2', ['b?']), ask('q3', ['c?']), ask('q4', ['d?']), ask('q5', ['e?']), ask('q6', ['f?'])];
      const { svc, complete } = deps({ completions });
      await svc.start('ws1', INPUT);
      let last: any;
      for (let i = 0; i < 10; i++) {
        last = await svc.answer('ws1', 'sess1', [`answer ${i}`]);
        if ('done' in last) break;
      }
      expect(last).toEqual({ done: true });
      // 1 auto-analysis call + at most MAX_TURNS(6) interview turns = 7; never runaway.
      expect(complete.mock.calls.length).toBeLessThanOrEqual(7);
    });

    it('gracefully skips when AI is not configured', async () => {
      const { svc } = deps({ aiEnabled: false });
      expect(await svc.answer('ws1', 'sess1', ['x'])).toEqual({ skipped: 'ai-not-configured' });
    });
  });
});
