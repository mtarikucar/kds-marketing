import { vi } from 'vitest';
import type { FetchRoutes } from './render';
import { contentPageFetch } from './contentPage';

export function area(id = 'area1', patch: Record<string, unknown> = {}) {
  return { id, workspace_id: 'w', title: `Alan ${id}`, brief: 'Yeni kupaları tanıt', revision: 4,
    archived: false, sources: [], requests: [], outputs: [], production_ids: [], invalidated_production_ids: [],
    created_at: '2026-10-01T09:00:00Z', updated_at: '2026-10-01T09:00:00Z', start_at: null,
    opened_by: { kind: 'human' }, packages: [], redo: null, progress: null, refused: 0,
    ...patch };
}
export const version = { id: 'v1', format: 'feed_post', capability_id: null, text: 'Yeni kupa serisi', title: 'Kupalar', tags: ['atölye'], link: null, material_ids: ['m1'], hypothesis_id: 'h1', content_type: null, slot_id: null };
export const pack = { revision: 1, delivered_at: '2026-11-01T10:00:00Z', by: 'agent1', summary: 'Sıcak renklerle hazırlandı.', versions: [version] };
export const detail = (project = area(), materials: unknown[] = []) => ({ project, materials, productions: [], publications: [] });

/** The content page's reads with the shared fixtures; `answers` add or replace routes. */
export function contentFetch(options: { answers?: FetchRoutes } = {}) {
  const calls = contentPageFetch(options.answers);
  const base = globalThis.fetch;
  const updates = new Map<string, unknown>();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await base(input, init);
    const url = new URL(String(input), 'http://panel.test');
    // A person's decision answers the area as it is afterwards; later reads see that area.
    const decided = url.pathname.match(/^\/api\/content\/areas\/([^/]+)\/(?:redo|delivery\/accept)$/);
    if (decided && init?.method === 'POST' && response.ok) updates.set(`/api/studio/projects/${decided[1]}`, await response.clone().json());
    if ((init?.method ?? 'GET') === 'GET' && updates.has(url.pathname)) return new Response(JSON.stringify(updates.get(url.pathname)), { headers: { 'content-type': 'application/json' } });
    return response;
  });
  return calls;
}
