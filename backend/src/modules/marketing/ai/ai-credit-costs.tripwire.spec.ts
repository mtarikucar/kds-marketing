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
      'content.compose',
      'conversation.followup',
      'conversation.reply',
      'funnel.draft',
      'media.image.generate',
      'media.video.generate',
      'review.reply_draft',
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
      expect(['default', 'light', 'conversation']).toContain(cfg.tier);
      // guards against a typo'd action key being readable
      expect(action.length).toBeGreaterThan(0);
    }
  });

  it('classification runs on the cheap light tier; ask runs deeper at 2 credits', () => {
    expect(tierFor('workflow.ai_classify')).toBe('light');
    expect(creditCost('ask_ai.question')).toBe(2);
    expect(creditCost('conversation.reply')).toBe(1);
    expect(tierFor('conversation.reply')).toBe('conversation');
    expect(tierFor('conversation.followup')).toBe('conversation');
  });
});
