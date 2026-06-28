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
  it('decodes decimal numeric entities (smart quotes etc.)', () => {
    // &#8217; = right single quote (’) — pervasive in real email templates.
    expect(htmlToText('<p>Don&#8217;t miss out</p>')).toBe('Don’t miss out');
  });
  it('decodes hex numeric entities (em dash etc.)', () => {
    // &#x2014; = em dash (—)
    expect(htmlToText('<p>A&#x2014;B</p>')).toBe('A—B');
  });
  it('leaves an unknown entity intact rather than mangling it', () => {
    expect(htmlToText('<p>a &notareal; b</p>')).toBe('a &notareal; b');
  });
  it('does not double-decode an encoded entity (&amp;lt; stays &lt;)', () => {
    expect(htmlToText('<p>a &amp;lt; b</p>')).toBe('a &lt; b');
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
