import { ResearchWorkerService } from './research-worker.service';
import { ResearchJob } from './research-job.service';

const JOB: ResearchJob = {
  workspaceId: 'ws1', workspaceSlug: 'acme', productName: 'Jeeta', productUrl: null,
  productDescription: 'CRM for salons', defaultLanguage: 'tr',
  profile: { id: 'p1', name: 'Salons İzmir', icpDescription: 'Busy salons with poor booking', productPitch: null, geo: { country: 'TR', cities: ['İzmir'] }, language: 'tr', businessTypes: ['SALON'], exclusions: null, lastRunAt: null },
  remainingToday: 20, maxBatchSize: 50,
};

function deps(overrides: { enabled?: boolean; aiEnabled?: boolean; completions?: any[] } = {}) {
  const complete = jest.fn();
  (overrides.completions ?? []).forEach((c) => complete.mockResolvedValueOnce(c));
  const anthropic = { isEnabled: () => overrides.aiEnabled ?? true, complete };
  const credits = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined) };
  const runs = {
    track: jest.fn(async (_ws: string, _in: unknown, fn: (id: string) => Promise<unknown>) => fn('run1')),
    recordTool: jest.fn().mockResolvedValue(undefined),
  };
  const sources = {
    isEnabled: () => overrides.enabled ?? true,
    apify: { searchPlaces: jest.fn().mockResolvedValue([{ name: 'Cafe X', phone: '+905551112233' }]), lookupInstagram: jest.fn() },
    firecrawl: { scrape: jest.fn(), searchWeb: jest.fn(), isConfigured: () => true },
    native: { scrape: jest.fn(), searchWeb: jest.fn(), isConfigured: () => false },
  };
  (sources.apify as any).isConfigured = () => true;
  const spend = { settle: jest.fn().mockResolvedValue(null) };
  const candidates = { stage: jest.fn().mockResolvedValue({ staged: 1, duplicates: 0 }) };
  const prisma = { researchProfile: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
  // Default: no ACTIVE BrandProfile — keeps every pre-existing test's brief
  // assertions unaffected. Brand-injection tests override per-case.
  const brandContext = { summaryFor: jest.fn().mockResolvedValue(null) };
  const svc = new ResearchWorkerService(prisma as any, anthropic as any, credits as any, runs as any, sources as any, spend as any, candidates as any, brandContext as any);
  return { svc, complete, credits, runs, sources, spend, candidates, prisma, brandContext };
}

const toolUse = (id: string, name: string, input: unknown) => ({ id, name, input });
const completion = (toolUses: any[]) => ({ text: '', toolUses, stopReason: 'tool_use', usage: { input: 10, output: 10 } });

describe('ResearchWorkerService', () => {
  it('is inert when no source providers are configured', async () => {
    const { svc, credits } = deps({ enabled: false });
    const r = await svc.runProfile(JOB);
    expect(r).toEqual({ runId: null, researched: 0, staged: 0, duplicates: 0, skipped: 'sources-not-configured' });
    expect(credits.reserve).not.toHaveBeenCalled();
  });

  it('is inert when AI is not configured', async () => {
    const { svc } = deps({ aiEnabled: false });
    expect((await svc.runProfile(JOB)).skipped).toBe('ai-not-configured');
  });

  it('runs the tool-loop, validates + stages qualified candidates, meters per-lead', async () => {
    const good = { externalRef: 'phone:+905551112233', businessName: 'Cafe X', businessType: 'CAFE', painPoint: 'Slow booking, angry reviews', evidence: 'https://maps.example/x — "waited 40 min"', pitch: 'Merhaba! Randevu...' };
    const bad = { externalRef: 'not-a-ref', businessName: '', businessType: 'CAFE', painPoint: '', evidence: '', pitch: '' };
    const { svc, complete, candidates, spend } = deps({
      completions: [
        completion([toolUse('t1', 'search_places', { query: 'salon izmir' })]),
        completion([toolUse('t2', 'submit_candidates', { candidates: [good, bad] })]),
      ],
    });
    const r = await svc.runProfile(JOB);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(r.researched).toBe(1); // the malformed candidate is dropped
    expect(candidates.stage).toHaveBeenCalledWith('ws1', 'p1', 'run1', [expect.objectContaining({ externalRef: 'phone:+905551112233' })]);
    expect(spend.settle).toHaveBeenCalledWith('ws1', expect.objectContaining({ unit: 'RESEARCH_LEAD', quantity: 1 }));
  });

  it('grounds the brief in the workspace brand block when an ACTIVE BrandProfile exists', async () => {
    const { svc, complete, brandContext } = deps({
      completions: [completion([toolUse('t2', 'submit_candidates', { candidates: [] })])],
    });
    brandContext.summaryFor.mockResolvedValue('Brand: Acme\nWe sell X.');

    await svc.runProfile(JOB);

    expect(brandContext.summaryFor).toHaveBeenCalledWith('ws1');
    const brief = complete.mock.calls[0][0].messages[0].content;
    expect(brief).toContain('BRAND CONTEXT');
    expect(brief).toContain('Brand: Acme');
  });

  it('omits the BRAND CONTEXT line when no ACTIVE BrandProfile exists', async () => {
    const { svc, complete } = deps({
      completions: [completion([toolUse('t2', 'submit_candidates', { candidates: [] })])],
    });

    await svc.runProfile(JOB);

    const brief = complete.mock.calls[0][0].messages[0].content;
    expect(brief).not.toContain('BRAND CONTEXT');
  });

  it('refunds the credit reserve if the run throws', async () => {
    const { svc, credits, complete } = deps({ completions: [] });
    complete.mockRejectedValueOnce(new Error('anthropic down'));
    await expect(svc.runProfile(JOB)).rejects.toThrow('anthropic down');
    expect(credits.refund).toHaveBeenCalled();
  });
});

/**
 * The loop can run out of iterations/tool-budget while the model is still
 * gathering, and never call submit_candidates — silently dropping every
 * prospect it found (observed live: 7 searches + 10 scrapes, 0 submits, "0
 * qualified"). A forced final turn converts that research into candidates.
 */
describe('ResearchWorkerService — forced final submit', () => {
  const good = {
    externalRef: 'phone:+905551112233', businessName: 'Cafe X', businessType: 'CAFE',
    painPoint: 'Slow booking', evidence: 'https://maps.example/x', pitch: 'Merhaba!',
  };

  it('forces a submit_candidates turn when the loop ends without one, recovering candidates', async () => {
    // 8 iterations that only ever search — never submit — then the forced turn.
    const searches = Array.from({ length: 8 }, (_v, i) => completion([toolUse(`s${i}`, 'search_places', { query: 'salon' })]));
    const { svc, complete, candidates } = deps({
      completions: [...searches, completion([toolUse('f1', 'submit_candidates', { candidates: [good] })])],
    });

    const r = await svc.runProfile(JOB);

    // The final call is the FORCED one: only the submit tool, tool_choice pinned.
    const forcedCall = complete.mock.calls[complete.mock.calls.length - 1][0];
    expect(forcedCall.toolChoice).toEqual({ type: 'tool', name: 'submit_candidates' });
    expect(forcedCall.tools).toHaveLength(1);
    expect(forcedCall.tools[0].name).toBe('submit_candidates');
    // The prospect the loop gathered is recovered, not dropped.
    expect(candidates.stage).toHaveBeenCalledWith('ws1', 'p1', 'run1', [expect.objectContaining({ businessName: 'Cafe X' })]);
    expect(r.researched).toBe(1);
  });

  it('does NOT force a submit when the model already submitted (even if empty)', async () => {
    const { svc, complete } = deps({
      completions: [
        completion([toolUse('t1', 'search_places', { query: 'salon' })]),
        completion([toolUse('t2', 'submit_candidates', { candidates: [] })]),
      ],
    });

    await svc.runProfile(JOB);

    // No forced third call — the last call carried no tool_choice.
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls.every((c: any[]) => !c[0].toolChoice)).toBe(true);
  });

  it('does NOT force a submit when the model never used a research tool (nothing gathered)', async () => {
    // First turn returns no tool uses at all → loop breaks, toolCalls == 0.
    const { svc, complete } = deps({ completions: [completion([])] });
    await svc.runProfile(JOB);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

/**
 * `validate` is the only thing standing between the model's JSON and the
 * database. `stage` and `priority` were always checked against their enums;
 * `score` was accepted as any finite number, and the review queue sorted on it.
 * Runs came back on 0-100, 0-10 and 0-1 scales, so the ranking was noise.
 */
describe('ResearchWorkerService — score validation', () => {
  const base = {
    externalRef: 'phone:+905551112233',
    businessName: 'Cafe X',
    businessType: 'CAFE',
    painPoint: 'p',
    evidence: 'e',
    pitch: 'pi',
  };
  const validate = (score: unknown) => {
    const { svc } = deps({});
    return (svc as any).validate([{ ...base, score }])[0];
  };

  it('keeps an in-range score', () => {
    expect(validate(58).score).toBe(58);
    expect(validate(0).score).toBe(0);
    expect(validate(100).score).toBe(100);
  });

  it('drops a score outside 0-100 instead of storing it', () => {
    // Rescaling would be a guess, and a guess here invents a ranking.
    expect(validate(150).score).toBeUndefined();
    expect(validate(-5).score).toBeUndefined();
  });

  it('drops a non-numeric score', () => {
    expect(validate('high').score).toBeUndefined();
    expect(validate(null).score).toBeUndefined();
    expect(validate(undefined).score).toBeUndefined();
  });

  it('still accepts the candidate when the score is unusable', () => {
    // The score is an ordering hint; losing it must not lose the prospect.
    expect(validate(999).businessName).toBe('Cafe X');
  });
});
