import { NativeWebProvider } from './native-web.provider';

/**
 * This provider holds its own Anthropic client, because Anthropic's SERVER
 * tools (web_search / web_fetch) cannot be expressed through
 * AnthropicService.complete(). The consequence, until now, was that it sat
 * entirely outside the cost accounting: August's invoice carried 2.35M Haiku
 * input tokens and 118 billed searches the product had no record of, and that
 * was the whole gap between measured spend and the real bill.
 */
describe('NativeWebProvider — usage reporting', () => {
  const usage = {
    input_tokens: 1200,
    output_tokens: 300,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 3, web_fetch_requests: 0 },
  } as never;

  type Reporter = {
    report: (ws: string | undefined, action: string, u: unknown) => void;
  };

  function setup() {
    const anthropic = { recordExternalUsage: jest.fn().mockResolvedValue(undefined) };
    const provider = new NativeWebProvider(anthropic as never);
    return { provider: provider as never as Reporter, anthropic };
  }

  it('records nothing without a workspace — never guess a tenant', () => {
    const { provider, anthropic } = setup();
    provider.report(undefined, 'research.native_search', usage);
    expect(anthropic.recordExternalUsage).not.toHaveBeenCalled();
  });

  it('records nothing when the call returned no usage', () => {
    const { provider, anthropic } = setup();
    provider.report('ws-1', 'research.native_search', undefined);
    expect(anthropic.recordExternalUsage).not.toHaveBeenCalled();
  });

  it('attributes usage — including the billed searches — to the caller workspace', () => {
    const { provider, anthropic } = setup();
    provider.report('ws-1', 'research.native_search', usage);

    expect(anthropic.recordExternalUsage).toHaveBeenCalledWith(
      'ws-1',
      'research.native_search',
      usage,
      expect.any(String),
    );
    // The Usage object carries server_tool_use, which is where the per-search
    // price lives — no token column can express it.
    const passed = anthropic.recordExternalUsage.mock.calls[0][2] as {
      server_tool_use: { web_search_requests: number };
    };
    expect(passed.server_tool_use.web_search_requests).toBe(3);
  });

  it('keeps two overlapping runs apart', () => {
    // The workspace travels WITH the call rather than living on the instance.
    // An ambient "current workspace" field on this singleton would cross-
    // attribute a nightly fan-out, where overlapping runs are the normal case.
    const { provider, anthropic } = setup();
    provider.report('ws-a', 'research.native_search', usage);
    provider.report('ws-b', 'research.native_scrape', usage);

    expect(anthropic.recordExternalUsage.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      'ws-a',
      'ws-b',
    ]);
  });

  it('never throws out of reporting — accounting cannot fail a research step', () => {
    const anthropic = { recordExternalUsage: jest.fn().mockRejectedValue(new Error('db down')) };
    const provider = new NativeWebProvider(anthropic as never) as never as Reporter;
    expect(() => provider.report('ws-1', 'research.native_search', usage)).not.toThrow();
  });
});
