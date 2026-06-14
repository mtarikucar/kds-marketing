import { WorkflowActionHandler, WorkflowContext } from './workflow-action.handler';

/**
 * interpolate() feeds PLAIN-TEXT sinks only (sendPlainEmail text body, SMS /
 * WhatsApp / webchat). It must NOT HTML-escape — escaping there corrupts
 * legitimate content while adding no safety (the sink isn't HTML). The
 * whitelist token replace (resolveField, lead/trigger/context roots only) is
 * the injection-safe part and is exercised here implicitly.
 */
describe('WorkflowActionHandler.interpolate', () => {
  // interpolate() only touches ctx via resolveField, so the injected services
  // are irrelevant here — construct with nulls and reach the private method.
  const handler = new WorkflowActionHandler(
    null as any, null as any, null as any, null as any,
    null as any, null as any, null as any, null as any,
  );
  const interpolate = (tpl: string, ctx: WorkflowContext): string =>
    (handler as any).interpolate(tpl, ctx);

  const ctx: WorkflowContext = {
    workspaceId: 'ws-1',
    lead: { contactPerson: "Ben & Jerry's <VIP>" },
    trigger: {},
    context: {},
  };

  it('does NOT HTML-escape resolved values', () => {
    const out = interpolate('Hi {{lead.contactPerson}}', ctx);
    expect(out).toBe("Hi Ben & Jerry's <VIP>");
    // The old behavior would have produced &amp; / &lt; / &#39; — assert those
    // entities never appear.
    expect(out).not.toContain('&amp;');
    expect(out).not.toContain('&lt;');
    expect(out).not.toContain('&#39;');
  });

  it('replaces unknown / null tokens with empty string', () => {
    expect(interpolate('x={{lead.missing}}=y', ctx)).toBe('x==y');
  });

  it('only substitutes whitelisted {{...}} tokens, leaving other text intact', () => {
    expect(interpolate('literal {braces} & text', ctx)).toBe('literal {braces} & text');
  });
});
