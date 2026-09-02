import { BrandSafetyService } from './brand-safety.service';
import { creditCost } from './ai-credit-costs';

/**
 * The one brand-safety screen, and the reason it reports THREE verdicts.
 *
 * It used to be a private boolean on the social-campaigns service, which folded
 * "a reviewer read this and it is fine" together with "no reviewer ran" — and
 * then the only caller that had a screen at all was the one that happened to
 * live in that file. Both facts matter here: the verdicts stay distinguishable,
 * and the credit accounting stays exactly what it was, because the unattended
 * community publisher now pays the same cost on the same path.
 */
function deps(over: { enabled?: boolean; text?: string; error?: Error } = {}) {
  const anthropic = {
    isEnabled: jest.fn().mockReturnValue(over.enabled ?? true),
    complete: jest.fn(async () => {
      if (over.error) throw over.error;
      return { text: over.text ?? 'SAFE' };
    }),
  };
  const credits = { reserve: jest.fn(), refund: jest.fn() };
  return { svc: new BrandSafetyService(anthropic as never, credits as never), anthropic, credits };
}

const COST = creditCost('workflow.ai_classify');

describe('BrandSafetyService.screen', () => {
  it('SAFE copy → SAFE, charged once, attributed to the workspace', async () => {
    const { svc, anthropic, credits } = deps({ text: 'SAFE' });
    await expect(svc.screen('ws1', 'perfectly ordinary copy')).resolves.toBe('SAFE');
    expect(credits.reserve).toHaveBeenCalledWith('ws1', COST);
    expect(credits.refund).not.toHaveBeenCalled();
    // Without BOTH of these the vendor cost never reaches AiUsageLog: the
    // credit is charged and nothing records what it cost us.
    expect(anthropic.complete).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws1', action: 'workflow.ai_classify' }),
    );
  });

  it('a BLOCK anywhere in the reply is a BLOCK', async () => {
    const { svc } = deps({ text: 'BLOCK' });
    await expect(svc.screen('ws1', 'hateful copy')).resolves.toBe('BLOCK');
  });

  it('AI not configured → UNAVAILABLE, and nothing is charged', async () => {
    // NOT "SAFE". Nothing read the copy, so nothing cleared it — the caller
    // decides what to do about that, and the two callers decide differently.
    const { svc, anthropic, credits } = deps({ enabled: false });
    await expect(svc.screen('ws1', 'copy')).resolves.toBe('UNAVAILABLE');
    expect(credits.reserve).not.toHaveBeenCalled();
    expect(anthropic.complete).not.toHaveBeenCalled();
  });

  it('a provider error → UNAVAILABLE, and the reserved credit is refunded', async () => {
    const { svc, credits } = deps({ error: new Error('529 overloaded') });
    await expect(svc.screen('ws1', 'copy')).resolves.toBe('UNAVAILABLE');
    expect(credits.reserve).toHaveBeenCalledWith('ws1', COST);
    expect(credits.refund).toHaveBeenCalledWith('ws1', COST);
  });

  it('lets an exhausted-credits refusal out — being unable to PAY for the screen is not a verdict', async () => {
    const refund = jest.fn();
    const svc = new BrandSafetyService(
      { isEnabled: () => true, complete: jest.fn() } as never,
      { reserve: jest.fn().mockRejectedValue(new Error('AI_CREDITS_EXHAUSTED')), refund } as never,
    );
    await expect(svc.screen('ws1', 'copy')).rejects.toThrow('AI_CREDITS_EXHAUSTED');
    // And it is not swallowed into a refund of a reservation that never happened.
    expect(refund).not.toHaveBeenCalled();
  });

  it('truncates the copy it sends rather than shipping an unbounded prompt', async () => {
    const { svc, anthropic } = deps();
    await svc.screen('ws1', 'x'.repeat(5000));
    expect(anthropic.complete.mock.calls[0][0].messages[0].content).toHaveLength(2000);
  });
});
