import { renderEmailHtml } from './emailtemplate.render';

/**
 * The email renderer is the trust boundary for customer-authored campaign HTML:
 * all text is HTML-escaped, img/href URLs are http(s)-only, and there is NO
 * inline JS — a malicious block can't inject script into a recipient's inbox.
 */
describe('renderEmailHtml', () => {
  it('escapes customer content (no script injection)', () => {
    const html = renderEmailHtml([{ type: 'heading', text: '<script>alert(1)</script>' }]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('neutralises a javascript: button URL and a data: image URL', () => {
    const html = renderEmailHtml([
      { type: 'button', text: 'Go', url: 'javascript:alert(1)' },
      { type: 'image', url: 'data:text/html,<script>x</script>', alt: 'x' },
    ]);
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text/html');
    expect(html).toContain('href="#"');
    expect(html).toContain('src="#"');
  });

  it('renders a table-based layout with the block types', () => {
    const html = renderEmailHtml(
      [
        { type: 'heading', text: 'Hi' },
        { type: 'text', text: 'line1\nline2' },
        { type: 'button', text: 'Buy', url: 'https://shop.example/x' },
        { type: 'divider' },
        { type: 'spacer', height: 40 },
        { type: 'columns', columns: [{ text: 'left' }, { text: 'right' }] },
      ],
      { accent: '#ff0000' },
    );
    expect(html).toContain('<table');
    expect(html).toContain('line1<br>line2'); // newline → <br>
    expect(html).toContain('https://shop.example/x');
    expect(html).toContain('#ff0000'); // accent on the button
    expect(html).toContain('height:40px');
    expect(html).toContain('>left<');
    expect(html).toContain('>right<');
  });

  it('does not crash on a malformed (non-array / non-object) block input', () => {
    expect(() => renderEmailHtml('oops' as any)).not.toThrow();
    expect(() => renderEmailHtml([null, 7, { type: 'text', text: 'ok' }] as any)).not.toThrow();
  });

  it('ignores a bogus accent and renders a hidden preheader', () => {
    const html = renderEmailHtml([{ type: 'text', text: 'x' }], { accent: 'red;}body{' }, 'Preview me');
    expect(html).not.toContain('red;}body{');
    expect(html).toContain('Preview me');
    expect(html).toContain('display:none');
  });
});
