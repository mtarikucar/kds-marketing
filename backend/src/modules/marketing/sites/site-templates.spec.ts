import { SITE_TEMPLATES, listSiteTemplates, findSiteTemplate } from './site-templates';

// The renderer's known block types (site-renderer.service.ts switch).
const RENDERABLE = new Set(['hero', 'features', 'pricing', 'faq', 'cta', 'text', 'form']);

describe('site-templates (A5 starter catalog)', () => {
  it('lists templates as {id,name,description} without leaking blocks', () => {
    const list = listSiteTemplates();
    expect(list.length).toBe(SITE_TEMPLATES.length);
    expect(list[0]).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String), description: expect.any(String) }));
    expect((list[0] as any).blocks).toBeUndefined();
  });

  it('every template uses only block types the renderer understands', () => {
    for (const t of SITE_TEMPLATES) {
      expect(t.blocks.length).toBeGreaterThan(0);
      for (const b of t.blocks) expect(RENDERABLE.has(String((b as any).type))).toBe(true);
    }
  });

  it('findSiteTemplate resolves a known id and rejects an unknown one', () => {
    expect(findSiteTemplate('lead-magnet')?.title).toBeTruthy();
    expect(findSiteTemplate('nope')).toBeUndefined();
  });
});
