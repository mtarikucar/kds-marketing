import { BrandSynthesisService } from './brand-synthesis.service';
import { creditCost } from '../ai/ai-credit-costs';
import { BrandSourceResult } from './sources/brand-source';

/**
 * Brand Brain synthesis (Task 11) — one metered Claude call forced to emit
 * valid JSON via tool-use. Covers the reserve/refund credit pattern, the
 * retry-once-then-fail behavior when the model doesn't call the tool, and
 * that the digest excludes inert/error source material.
 */
describe('BrandSynthesisService', () => {
  const WS = 'ws-1';
  let anthropic: any;
  let credits: any;
  let svc: BrandSynthesisService;

  const okWebsiteResult: BrandSourceResult = {
    source: 'website',
    status: 'ok',
    raw: [{ url: 'https://acme.test', markdown: 'Acme sells fast espresso machines.' }],
    firecrawlPages: 1,
  };

  beforeEach(() => {
    anthropic = { isEnabled: jest.fn().mockReturnValue(true), complete: jest.fn() };
    credits = { reserve: jest.fn(), refund: jest.fn() };
    svc = new BrandSynthesisService(anthropic as any, credits as any);
  });

  it('returns a normalized draft on a successful tool call and reserves credits without refunding', async () => {
    anthropic.complete.mockResolvedValue({
      text: '',
      toolUses: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'submit_brand_profile',
          input: {
            profile: { brandName: 'Acme', valueProps: ['fast'] },
            researchProfile: { businessTypes: ['cafe'] },
            brandKitHints: { tone: 'warm' },
            knowledgeDocs: [{ title: 'About', content: '...' }],
          },
        },
      ],
      stopReason: 'tool_use',
    });

    const draft = await svc.synthesize(WS, [okWebsiteResult], 'tr');

    expect(draft.profile.brandName).toBe('Acme');
    expect(draft.profile.valueProps).toEqual(['fast']);
    // Defensive defaults kick in for fields the model omitted.
    expect(draft.profile.toneWords).toEqual([]);
    expect(draft.profile.audienceObjections).toEqual([]);
    expect(draft.researchProfile.businessTypes).toEqual(['cafe']);
    expect(draft.brandKitHints.tone).toBe('warm');
    expect(draft.brandKitHints.palette).toEqual([]);
    expect(draft.knowledgeDocs).toEqual([{ title: 'About', content: '...' }]);

    expect(credits.reserve).toHaveBeenCalledTimes(1);
    expect(credits.reserve).toHaveBeenCalledWith(WS, creditCost('brand.analyze'));
    expect(credits.refund).not.toHaveBeenCalled();
  });

  it('retries once when the model does not call the tool, then succeeds', async () => {
    anthropic.complete
      .mockResolvedValueOnce({ text: '', toolUses: [], stopReason: 'end_turn' })
      .mockResolvedValueOnce({
        text: '',
        toolUses: [
          {
            type: 'tool_use',
            id: 't2',
            name: 'submit_brand_profile',
            input: {
              profile: { brandName: 'Acme' },
              researchProfile: {},
              brandKitHints: {},
              knowledgeDocs: [],
            },
          },
        ],
        stopReason: 'tool_use',
      });

    const draft = await svc.synthesize(WS, [okWebsiteResult], 'tr');

    expect(draft.profile.brandName).toBe('Acme');
    expect(anthropic.complete).toHaveBeenCalledTimes(2);
    expect(credits.refund).not.toHaveBeenCalled();
  });

  it('rejects and refunds when the model never calls the tool after retries', async () => {
    anthropic.complete.mockResolvedValue({ text: '', toolUses: [], stopReason: 'end_turn' });

    await expect(svc.synthesize(WS, [okWebsiteResult], 'tr')).rejects.toThrow();

    expect(credits.refund).toHaveBeenCalledTimes(1);
    expect(credits.refund).toHaveBeenCalledWith(WS, creditCost('brand.analyze'));
  });

  it('rejects with ServiceUnavailableException when AI is disabled, without reserving credits', async () => {
    anthropic.isEnabled.mockReturnValue(false);

    await expect(svc.synthesize(WS, [okWebsiteResult], 'tr')).rejects.toThrow('AI is not configured');

    expect(credits.reserve).not.toHaveBeenCalled();
  });

  it('builds a digest that skips inert/error sources and includes ok website markdown', async () => {
    anthropic.complete.mockResolvedValue({
      text: '',
      toolUses: [
        {
          type: 'tool_use',
          id: 't3',
          name: 'submit_brand_profile',
          input: { profile: {}, researchProfile: {}, brandKitHints: {}, knowledgeDocs: [] },
        },
      ],
      stopReason: 'tool_use',
    });

    const inertResult: BrandSourceResult = { source: 'social', status: 'inert', raw: null };
    const errorResult: BrandSourceResult = { source: 'gbp', status: 'error', raw: null, error: 'boom' };

    await svc.synthesize(WS, [okWebsiteResult, inertResult, errorResult], 'tr');

    const content = anthropic.complete.mock.calls[0][0].messages[0].content;
    expect(content).toContain('Acme sells fast espresso machines.');
    expect(content).not.toContain('boom');
    expect(content).not.toContain('inert');
  });
});
