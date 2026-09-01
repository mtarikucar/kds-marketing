import { AI_CREDIT_COSTS, creditCost, tierFor } from './ai-credit-costs';

/**
 * Cost-table tripwire. Every metered AI action is a billing decision: a new
 * one must not ship without an explicit credit cost + model tier. Pinning the
 * key set turns "forgot to price the new action" into a red build rather than
 * a free (un-metered) AI call in production.
 */
describe('ai-credit-costs — cost table tripwire', () => {
  it('pins the metered AI actions (a new action = a conscious cost decision)', () => {
    expect(Object.keys(AI_CREDIT_COSTS).sort()).toEqual([
      'ask_ai.question',
      'ask_ai.turn',
      'brand.analyze',
      'command.request',
      'command.turn',
      'content.compose',
      'content.concepts',
      'conversation.followup',
      'conversation.reply',
      'funnel.draft',
      'media.image.generate',
      'media.video.generate',
      'research.native_scrape',
      'research.native_search',
      'research.qualify',
      'research.turn',
      'review.reply_draft',
      'social.publish.x',
      'social.publish.x_link',
      'strategy.interview',
      'strategy.synthesize',
      'strategy.turn',
      'stt.minute',
      'voice.analysis',
      'voice.copilot',
      'voice.turn',
      'workflow.ai_classify',
      'workflow.ai_generate',
      'workflow.draft',
    ]);
  });

  it('prices media generation as a positive default-tier floor', () => {
    expect(creditCost('media.image.generate')).toBeGreaterThan(0);
    expect(creditCost('media.video.generate')).toBeGreaterThan(0);
    expect(tierFor('media.image.generate')).toBe('default');
    expect(tierFor('media.video.generate')).toBe('default');
  });

  it('every action has a positive integer credit cost and a known tier', () => {
    for (const [action, cfg] of Object.entries(AI_CREDIT_COSTS)) {
      expect(Number.isInteger(cfg.credits)).toBe(true);
      expect(cfg.credits).toBeGreaterThan(0);
      expect(['default', 'balanced', 'light', 'conversation']).toContain(cfg.tier);
      // guards against a typo'd action key being readable
      expect(action.length).toBeGreaterThan(0);
    }
  });

  it('prices X (Twitter) publishing; a link tweet costs more than a plain one', () => {
    expect(creditCost('social.publish.x')).toBe(2);
    expect(creditCost('social.publish.x_link')).toBe(20);
    expect(creditCost('social.publish.x_link')).toBeGreaterThan(creditCost('social.publish.x'));
  });

  it('prices the strategy-engine AI steps (interview cheap, synthesis heavier)', () => {
    expect(creditCost('strategy.interview')).toBe(2);
    expect(tierFor('strategy.interview')).toBe('default');
    expect(tierFor('strategy.synthesize')).toBe('default');
    // A synthesis run costs its base PLUS at least one turn, so it stays
    // strictly heavier than an interview turn even at the minimum.
    expect(
      creditCost('strategy.synthesize') + creditCost('strategy.turn'),
    ).toBeGreaterThan(creditCost('strategy.interview'));
  });

  it('classification runs on the cheap light tier', () => {
    expect(tierFor('workflow.ai_classify')).toBe('light');
    expect(creditCost('conversation.reply')).toBe(1);
    expect(tierFor('conversation.reply')).toBe('conversation');
    expect(tierFor('conversation.followup')).toBe('conversation');
  });

  /**
   * The reason `*.turn` exists. A multi-call agent loop used to reserve ONCE
   * per run, so the same credit price bought one Opus call or ten — the credit
   * ceiling bounded credits, not dollars, and the spread across actions
   * reached ~550x. Each looping action must therefore carry a per-turn price,
   * and that price must dominate its base: if a base ever grew larger than a
   * turn, per-run charging would be creeping back in.
   */
  it('every looping action charges per turn, and the turn dominates the base', () => {
    const LOOPS: Array<[Parameters<typeof creditCost>[0], Parameters<typeof creditCost>[0]]> = [
      ['ask_ai.question', 'ask_ai.turn'],
      ['research.qualify', 'research.turn'],
      ['strategy.synthesize', 'strategy.turn'],
    ];
    for (const [base, turn] of LOOPS) {
      expect(creditCost(turn)).toBeGreaterThan(0);
      expect(creditCost(turn)).toBeGreaterThanOrEqual(creditCost(base));
      expect(tierFor(turn)).toBe(tierFor(base));
    }
  });

  /**
   * Anchor check: 1 credit is meant to be ~$0.01 of vendor spend. These are
   * the actions whose prices were derived from their maxTokens ceiling at
   * Opus 4.8 rates; pinning them keeps a future edit from quietly restoring
   * the under-pricing (funnel.draft in particular was 3 credits for ~$0.081).
   */
  it('prices single-call Opus actions from their token ceiling', () => {
    expect(creditCost('funnel.draft')).toBe(9);
    expect(creditCost('content.compose')).toBe(3);
    expect(creditCost('workflow.ai_generate')).toBe(2);
    expect(creditCost('review.reply_draft')).toBe(2);
    expect(creditCost('brand.analyze')).toBe(15);
    // The widest single call in the table: N whole shot plans at maxTokens 6000.
    expect(creditCost('content.concepts')).toBe(16);
    expect(tierFor('content.concepts')).toBe('default');
  });
});

/**
 * The cost table is only defensible if the expensive rows can point at a
 * measurement. These pin the two decisions taken on 2026-08-18 from AiUsageLog,
 * so a future re-tier has to argue with the data rather than drift past it.
 */
describe('ai-credit-costs — decisions backed by measured spend', () => {
  it('keeps research off Opus — it was 99% of spend at a 51:1 input ratio', () => {
    // The work is extraction from crawled text, and its output is gated behind
    // an explicit accept, so the cheaper model's downside is bounded.
    expect(tierFor('research.turn')).toBe('balanced');
    expect(tierFor('research.qualify')).toBe('balanced');
  });

  it('leaves genuine judgment work on the top tier', () => {
    // Named individually rather than "everything else": each of these is a
    // deliberate keep, not an oversight.
    expect(tierFor('strategy.turn')).toBe('default');
    expect(tierFor('strategy.synthesize')).toBe('default');
    expect(tierFor('brand.analyze')).toBe('default');
    expect(tierFor('funnel.draft')).toBe('default');
  });

  it('keeps realtime conversation on the fast tier', () => {
    // A caller is on the line; latency beats model quality.
    expect(tierFor('conversation.reply')).toBe('conversation');
    expect(tierFor('voice.copilot')).toBe('conversation');
  });
});
