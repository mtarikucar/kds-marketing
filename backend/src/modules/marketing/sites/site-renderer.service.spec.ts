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

  it('renders a popup block as a JS-free checkbox-hack modal (escaped, no inline JS)', () => {
    const html = svc.render(
      { title: 'T', blocks: [{ type: 'popup', heading: 'Wait! <b>10% off</b>', text: 'Join now', ctaText: 'Claim', ctaUrl: 'https://x.example' }] },
      new Map(),
      'https://m.example',
    );
    expect(html).toContain('class="pp-cb" checked'); // shows on load
    expect(html).toContain('class="pp-ov"');
    expect(html).not.toContain('<script'); // JS-free
    expect(html).toContain('&lt;b&gt;10% off'); // heading escaped
    expect(html).toContain('href="https://x.example"');
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

  it('renders select / radio / checkbox / date fields with escaped options (no script)', () => {
    const forms = new Map([['f1', {
      id: 'f1', name: 'Survey', fields: [
        { name: 'plan', label: 'Plan', type: 'select', options: ['Basic', 'Pro', '<x>'] },
        { name: 'how', label: 'How?', type: 'radio', options: ['Ad', 'Friend'] },
        { name: 'consent', label: 'I agree', type: 'checkbox', required: true },
        { name: 'topics', label: 'Topics', type: 'checkbox', options: ['News', 'Tips'] },
        { name: 'start', label: 'Start', type: 'date' },
      ],
    }]]);
    const html = svc.render({ title: 'T', blocks: [{ type: 'form', formId: 'f1' }] }, forms as any, 'https://m.example');
    expect(html).toContain('<select name="plan"');
    expect(html).toContain('<option value="Pro">Pro</option>');
    expect(html).toContain('&lt;x&gt;'); // option escaped
    expect(html).toContain('type="radio" name="how" value="Ad"');
    expect(html).toContain('type="checkbox" name="consent" value="yes" required');
    expect(html).toContain('type="checkbox" name="topics" value="News"');
    expect(html).toContain('type="date" name="start"');
    expect(html).not.toContain('<x>');
  });

  it('does not crash the whole page when a block array field is a non-array (unvalidated JSON)', () => {
    const forms = new Map([['f1', { id: 'f1', name: 'F', fields: 'nope' as any }]]);
    expect(() =>
      svc.render(
        {
          title: 'T',
          blocks: [
            { type: 'features', items: 'oops' },
            { type: 'pricing', plans: 'x' },
            { type: 'pricing', plans: [{ name: 'P', price: '$1', features: 'y' }] },
            { type: 'faq', items: 7 },
            { type: 'form', formId: 'f1' },
          ],
        },
        forms as any,
        'https://m.example',
      ),
    ).not.toThrow();
  });

  it('honors a valid accent theme color but ignores a bogus one', () => {
    const ok = svc.render({ title: 'T', blocks: [], theme: { accent: '#ff0000' } }, new Map(), '');
    expect(ok).toContain('#ff0000');
    const bad = svc.render({ title: 'T', blocks: [], theme: { accent: 'red;}body{x' } }, new Map(), '');
    expect(bad).not.toContain('red;}body{x');
  });

  describe("'callback' block (NetGSM Phase 5 Task 6 — leave your number, we call you now)", () => {
    // Final-review fix M2: redirectMenu/redirectType are NO LONGER carried as
    // hidden fields (the public endpoint now resolves the dial target itself,
    // server-side, from the tenant's published block config — see
    // SitesService.resolvePublicCallbackTarget — rather than trusting
    // whatever the request body says). This block's own redirectMenu still
    // gates whether the widget renders at all.
    it('renders a JS-free POST form to the public callback endpoint, WITHOUT redirectMenu/redirectType in the markup', () => {
      const html = svc.render(
        { title: 'T', blocks: [{ type: 'callback', heading: 'Call me', redirectMenu: '850-queue-vip', redirectType: 'queue' }] },
        new Map(),
        'https://m.example',
        { workspaceId: 'ws-1' },
      );
      expect(html).toContain('action="https://m.example/api/public/callback/ws-1"');
      expect(html).toContain('method="POST"');
      expect(html).not.toContain('redirectMenu');
      expect(html).not.toContain('redirectType');
      expect(html).toContain('type="tel" name="phone" required');
      expect(html).not.toContain('<script');
    });

    it('escapes customer-authored heading/text (no script injection)', () => {
      const html = svc.render(
        { title: 'T', blocks: [{ type: 'callback', heading: '<script>x</script>', redirectMenu: 'q1', redirectType: 'queue' }] },
        new Map(),
        'https://m.example',
        { workspaceId: 'ws-1' },
      );
      expect(html).not.toContain('<script>x</script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('renders TR default copy when the page is Turkish (seo.lang), EN otherwise', () => {
      const tr = svc.render(
        { title: 'T', blocks: [{ type: 'callback', redirectMenu: 'q1', redirectType: 'queue' }], seo: { lang: 'tr' } },
        new Map(),
        'https://m.example',
        { workspaceId: 'ws-1' },
      );
      expect(tr).toContain('Sizi hemen arayalım');

      const en = svc.render(
        { title: 'T', blocks: [{ type: 'callback', redirectMenu: 'q1', redirectType: 'queue' }] },
        new Map(),
        'https://m.example',
        { workspaceId: 'ws-1' },
      );
      expect(en).toContain('We&#39;ll call you right now'); // apostrophe HTML-escaped
    });

    it('renders nothing (no crash) without a workspaceId or without a configured redirectMenu', () => {
      const noWs = svc.render(
        { title: 'T', blocks: [{ type: 'callback', redirectMenu: 'q1', redirectType: 'queue' }] },
        new Map(),
        'https://m.example',
      );
      expect(noWs).not.toContain('api/public/callback');

      const noMenu = svc.render(
        { title: 'T', blocks: [{ type: 'callback', redirectType: 'queue' }] },
        new Map(),
        'https://m.example',
        { workspaceId: 'ws-1' },
      );
      expect(noMenu).not.toContain('api/public/callback');
    });
  });
});
