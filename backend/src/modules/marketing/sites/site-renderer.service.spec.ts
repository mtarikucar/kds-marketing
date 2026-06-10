import { SiteRendererService } from './site-renderer.service';

/**
 * The renderer is the trust boundary for customer-authored page content: all
 * text is HTML-escaped and hrefs are http(s)-only, so a malicious block can't
 * inject script or a javascript: URL.
 */
describe('SiteRendererService', () => {
  const svc = new SiteRendererService();

  it('escapes customer content (no script injection)', () => {
    const html = svc.render(
      { title: 'T', blocks: [{ type: 'hero', heading: '<script>alert(1)</script>', sub: 'hi' }] },
      new Map(),
      'https://m.example',
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('neutralises a javascript: CTA url', () => {
    const html = svc.render(
      { title: 'T', blocks: [{ type: 'hero', heading: 'h', ctaText: 'Go', ctaUrl: 'javascript:alert(1)' }] },
      new Map(),
      'https://m.example',
    );
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="#"');
  });

  it('renders a form block as a POST form to the public endpoint', () => {
    const forms = new Map([['f1', { id: 'f1', name: 'Contact', fields: [{ name: 'email', label: 'Email', type: 'email', required: true }] }]]);
    const html = svc.render(
      { title: 'T', blocks: [{ type: 'form', formId: 'f1' }] },
      forms as any,
      'https://m.example',
    );
    expect(html).toContain('action="https://m.example/api/public/f/f1"');
    expect(html).toContain('name="email"');
    expect(html).toContain('method="POST"');
  });

  it('honors a valid accent theme color but ignores a bogus one', () => {
    const ok = svc.render({ title: 'T', blocks: [], theme: { accent: '#ff0000' } }, new Map(), '');
    expect(ok).toContain('#ff0000');
    const bad = svc.render({ title: 'T', blocks: [], theme: { accent: 'red;}body{x' } }, new Map(), '');
    expect(bad).not.toContain('red;}body{x');
  });
});
