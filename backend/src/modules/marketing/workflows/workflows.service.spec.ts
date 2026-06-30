import { BadRequestException } from '@nestjs/common';
import { WorkflowsService } from './workflows.service';

/**
 * draft() turns a natural-language prompt into DSL via the model. The model is
 * unreliable: it sometimes emits prose-wrapped or truncated JSON. Any "the AI
 * didn't give us usable DSL" outcome must surface as a clean 400 (and refund the
 * reserved credits) — never leak a raw parser error as a 500.
 */
describe('WorkflowsService.draft', () => {
  function setup(modelText: string) {
    const anthropic = {
      isEnabled: () => true,
      complete: jest.fn().mockResolvedValue({ text: modelText }),
    };
    const credits = {
      reserve: jest.fn().mockResolvedValue(undefined),
      refund: jest.fn().mockResolvedValue(undefined),
    };
    const svc = new WorkflowsService(
      {} as any,
      {} as any,
      anthropic as any,
      credits as any,
    );
    return { svc, anthropic, credits };
  }

  it('maps malformed AI JSON to a 400 (not a 500) and refunds the reserved credits', async () => {
    // Has a leading { and a trailing } (so the brace-slice succeeds) but is not
    // valid JSON — the old code let JSON.parse throw a raw SyntaxError → 500.
    const { svc, credits } = setup('Sure! {"trigger": {"type": "lead.created"}, "steps": [ }');
    await expect(svc.draft('ws-1', 'welcome new leads')).rejects.toBeInstanceOf(BadRequestException);
    expect(credits.refund).toHaveBeenCalledTimes(1);
  });

  it('maps a well-formed JSON that fails the DSL schema to a 400 + refund', async () => {
    const { svc, credits } = setup('{"trigger": {"type": "not_a_real_trigger"}, "steps": []}');
    await expect(svc.draft('ws-1', 'do something')).rejects.toBeInstanceOf(BadRequestException);
    expect(credits.refund).toHaveBeenCalledTimes(1);
  });

  it('returns the parsed DSL on a valid draft (reserve kept, no refund)', async () => {
    const { svc, credits } = setup(
      'Here you go:\n{"trigger": {"type": "lead.created"}, "steps": [{"type": "stop_workflow"}]}',
    );
    const dsl = await svc.draft('ws-1', 'stop on new lead');
    expect(dsl.trigger.type).toBe('lead.created');
    expect(dsl.steps).toHaveLength(1);
    expect(credits.reserve).toHaveBeenCalledTimes(1);
    expect(credits.refund).not.toHaveBeenCalled();
  });
});
