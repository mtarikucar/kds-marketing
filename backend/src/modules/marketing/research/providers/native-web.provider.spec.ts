import { NativeWebProvider } from './native-web.provider';

/**
 * The native provider parses Anthropic server-tool result blocks into the
 * pipeline's WebHit/ScrapeResult shapes. The parsing is the whole risk surface
 * (block types, error blocks, nested document source), so it is what these
 * tests pin — the HTTP call itself is mocked.
 */
function withClient(provider: NativeWebProvider, create: jest.Mock) {
  (provider as unknown as { client: unknown }).client = { messages: { create } };
}

const OLD_ENV = process.env.ANTHROPIC_API_KEY;
beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-test';
});
afterAll(() => {
  if (OLD_ENV === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = OLD_ENV;
});

describe('NativeWebProvider.isConfigured', () => {
  it('is configured whenever the platform Anthropic key is present', () => {
    expect(new NativeWebProvider().isConfigured()).toBe(true);
  });

  it('is NOT configured without the key', () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(new NativeWebProvider().isConfigured()).toBe(false);
    process.env.ANTHROPIC_API_KEY = 'sk-test';
  });
});

describe('NativeWebProvider.searchWeb', () => {
  it('maps web_search_result blocks to WebHit[] and respects the limit', async () => {
    const provider = new NativeWebProvider();
    const create = jest.fn().mockResolvedValue({
      content: [
        { type: 'text', text: 'searching…' },
        {
          type: 'web_search_tool_result',
          tool_use_id: 't1',
          content: [
            { type: 'web_search_result', url: 'https://a.example', title: 'A', page_age: null },
            { type: 'web_search_result', url: 'https://b.example', title: 'B', page_age: null },
            { type: 'web_search_result', url: 'https://c.example', title: 'C', page_age: null },
          ],
        },
      ],
    });
    withClient(provider, create);

    const hits = await provider.searchWeb('etkinlik ajansı istanbul', 2);

    expect(hits).toEqual([
      { url: 'https://a.example', title: 'A' },
      { url: 'https://b.example', title: 'B' },
    ]);
    // TR user location is passed so Turkish-local results rank first.
    const tool = create.mock.calls[0][0].tools[0];
    expect(tool.type).toBe('web_search_20260209');
    expect(tool.user_location).toEqual({ type: 'approximate', country: 'TR' });
    expect(tool.max_uses).toBe(1);
    // Required by the cheap model tier — otherwise a 400 'does not support
    // programmatic tool calling'.
    expect(tool.allowed_callers).toEqual(['direct']);
  });

  it('returns [] when the search block is an error, not results', async () => {
    const provider = new NativeWebProvider();
    withClient(
      provider,
      jest.fn().mockResolvedValue({
        content: [
          { type: 'web_search_tool_result', tool_use_id: 't1', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
        ],
      }),
    );
    expect(await provider.searchWeb('x')).toEqual([]);
  });

  it('returns [] for a blank query without calling the API', async () => {
    const provider = new NativeWebProvider();
    const create = jest.fn();
    withClient(provider, create);
    expect(await provider.searchWeb('   ')).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('NativeWebProvider.scrape', () => {
  it('extracts the fetched document text and pins allowed_domains to the host', async () => {
    const provider = new NativeWebProvider();
    const create = jest.fn().mockResolvedValue({
      content: [
        {
          type: 'web_fetch_tool_result',
          tool_use_id: 't1',
          content: {
            type: 'web_fetch_result',
            url: 'https://acme.example/about',
            content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '# Acme\nWe make things.' } },
          },
        },
      ],
    });
    withClient(provider, create);

    const res = await provider.scrape('https://acme.example/about');

    expect(res?.markdown).toContain('We make things');
    const tool = create.mock.calls[0][0].tools[0];
    expect(tool.type).toBe('web_fetch_20260209');
    expect(tool.allowed_domains).toEqual(['acme.example']);
    expect(tool.allowed_callers).toEqual(['direct']);
  });

  it('returns null on a web_fetch error block', async () => {
    const provider = new NativeWebProvider();
    withClient(
      provider,
      jest.fn().mockResolvedValue({
        content: [
          { type: 'web_fetch_tool_result', tool_use_id: 't1', content: { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' } },
        ],
      }),
    );
    expect(await provider.scrape('https://acme.example')).toBeNull();
  });

  it('returns null for a malformed URL without calling the API', async () => {
    const provider = new NativeWebProvider();
    const create = jest.fn();
    withClient(provider, create);
    expect(await provider.scrape('not a url at all with spaces')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});
