import { ContentAiService } from './content-ai.service';

/**
 * Content AI (compose) grounds its system prompt in the workspace's Brand
 * Brain block when an ACTIVE profile exists, falling back to the plain
 * productName/productDescription form when it doesn't.
 */
describe('ContentAiService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let anthropic: any;
  let credits: any;
  let brandContext: any;
  let svc: ContentAiService;

  beforeEach(() => {
    prisma = {
      workspace: {
        findUnique: jest.fn().mockResolvedValue({
          productName: 'Widget',
          productDescription: 'A widget',
          defaultLanguage: 'tr',
        }),
      },
    };
    anthropic = {
      isEnabled: jest.fn().mockReturnValue(true),
      complete: jest.fn().mockResolvedValue({ text: 'BODY line' }),
    };
    credits = { reserve: jest.fn(), refund: jest.fn() };
    brandContext = { summaryFor: jest.fn() };
    svc = new ContentAiService(prisma as any, anthropic as any, credits as any, brandContext as any);
  });

  it('grounds the system prompt in the brand block when a brand is present', async () => {
    brandContext.summaryFor.mockResolvedValue('Brand: Acme\nWe sell X to cafes.');

    await svc.compose(WS, { kind: 'social', goal: 'promo' });

    const system = anthropic.complete.mock.calls[0][0].system;
    expect(system).toContain('Brand: Acme');
    expect(system).toContain('writing on behalf of this brand');
    expect(system).not.toContain('Product: A widget');
    expect(credits.reserve).toHaveBeenCalledTimes(1);
  });

  it('falls back to the plain productName/description form when there is no brand', async () => {
    brandContext.summaryFor.mockResolvedValue(null);

    await svc.compose(WS, { kind: 'social', goal: 'promo' });

    const system = anthropic.complete.mock.calls[0][0].system;
    expect(system).toContain('senior B2B marketing copywriter for "Widget"');
    expect(system).toContain('Product: A widget');
    expect(system).not.toContain('Brand: Acme');
  });
});
