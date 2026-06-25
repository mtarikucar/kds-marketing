import { describe, it, expect } from 'vitest';
import { htmlToText, plainTextBody } from './plainText';

describe('htmlToText', () => {
  it('strips tags and collapses whitespace', () => {
    expect(htmlToText('<h1>Hello</h1>\n<p>world  there</p>')).toBe('Hello world there');
  });
  it('decodes common entities', () => {
    expect(htmlToText('<p>Tom &amp; Jerry &lt;3 &nbsp;&quot;hi&quot;</p>')).toBe('Tom & Jerry <3 "hi"');
  });
  it('drops script/style content', () => {
    expect(htmlToText('<style>.a{}</style><p>keep</p><script>x()</script>')).toBe('keep');
  });
  it('returns empty string for empty/undefined input', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText(undefined)).toBe('');
  });
});

describe('plainTextBody', () => {
  it('uses the typed body when present', () => {
    expect(plainTextBody('typed text', '<p>html</p>')).toBe('typed text');
  });
  it('derives from HTML when the body is blank', () => {
    expect(plainTextBody('   ', '<p>Welcome &amp; hi</p>')).toBe('Welcome & hi');
  });
  it('returns empty when neither is present (caller validates)', () => {
    expect(plainTextBody('', '')).toBe('');
  });
});
