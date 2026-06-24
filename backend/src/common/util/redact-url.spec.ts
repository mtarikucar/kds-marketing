import { redactUrl } from './redact-url';

describe('redactUrl', () => {
  it('redacts the SSE access_token value (the credential-in-URL leak)', () => {
    expect(redactUrl('/api/marketing/conversations/stream?access_token=eyJhbGci.secret.sig')).toBe(
      '/api/marketing/conversations/stream?access_token=***',
    );
  });

  it('redacts assorted sensitive params, keeps benign ones', () => {
    const out = redactUrl('/x?token=abc&page=2&secret=zzz&refresh_token=rrr&q=hello');
    expect(out).toBe('/x?token=***&page=2&secret=***&refresh_token=***&q=hello');
  });

  it('leaves a URL with no query string untouched', () => {
    expect(redactUrl('/api/marketing/leads')).toBe('/api/marketing/leads');
  });

  it('leaves a benign query untouched', () => {
    expect(redactUrl('/api/marketing/leads?page=1&pageSize=20')).toBe('/api/marketing/leads?page=1&pageSize=20');
  });

  it('handles a valueless flag param without throwing', () => {
    expect(redactUrl('/x?token&flag')).toBe('/x?token&flag');
  });
});
