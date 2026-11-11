import { vi } from 'vitest';
import { mockFetch, type FetchRoutes } from './render';
import { studioAnswers } from './studio';
import { agents, strategyWithDraft } from './fixtures';

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

/** Query-aware project pages, while all other requests use the shared fixtures. */
export function contentFetch(options: { open?: unknown[]; done?: unknown[]; more?: unknown[]; archive?: unknown[]; answers?: FetchRoutes } = {}) {
  const calls = mockFetch({ ...studioAnswers, 'GET /api/agents': agents, 'GET /api/strategy': strategyWithDraft,
    'GET /api/studio/projects': { projects: [] }, ...options.answers });
  const base = globalThis.fetch;
  const updates = new Map<string, unknown>();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await base(input, init);
    const url = new URL(String(input), 'http://panel.test');
    // A person's decision answers the area as it is afterwards; later reads see that area.
    const redo = url.pathname.match(/^\/api\/content\/areas\/([^/]+)\/(?:redo|delivery\/accept)$/);
    if (redo && init?.method === 'POST' && response.ok) updates.set(`/api/studio/projects/${redo[1]}`, await response.clone().json());
    if ((init?.method ?? 'GET') === 'GET' && updates.has(url.pathname)) return new Response(JSON.stringify(updates.get(url.pathname)), { headers: { 'content-type': 'application/json' } });
    if (url.pathname !== '/api/studio/projects' || (init?.method ?? 'GET') !== 'GET') return response;
    const archived = url.searchParams.get('archived') === 'true';
    const done = url.searchParams.get('scope') === 'done';
    const more = url.searchParams.has('done_before');
    return new Response(JSON.stringify({ projects: archived ? options.archive ?? [] : done ? (more ? options.more : options.done) ?? [] : options.open ?? [], next_cursor: null, next_done_before: done && !more && options.more ? 'opaque-cursor' : null }), { headers: { 'content-type': 'application/json' } });
  });
  return calls;
}
