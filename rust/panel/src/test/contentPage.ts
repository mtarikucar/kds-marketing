import type { AreaRow, OlayViewOut, QueueItem, Stage, StageKey, StageState, TreeOut } from '@/api/content';
import { mockFetch, type FetchRoutes } from './render';
import { studioAnswers } from './studio';
import { agents, strategyWithDraft } from './fixtures';
import { material, olay } from './materials';

// The content page's reads in the server's shapes (`jt_app::usecases::content::views`).

const KEYS: StageKey[] = ['hazirlik', 'fikir', 'metin', 'gorsel', 'paket', 'onay', 'yayin', 'sonuc'];
const SPANS: Record<StageKey, [number, number] | null> = {
  hazirlik: [1, 3], fikir: [4, 6], metin: [7, 8], gorsel: [9, 10], paket: [11, 14], onay: null, yayin: null, sonuc: null,
};

/** Eight stages, each `todo` unless `patch` says otherwise. */
export function stages(patch: Partial<Record<StageKey, Partial<Stage> | StageState>> = {}): Stage[] {
  return KEYS.map((key) => {
    const p = patch[key];
    const extra = typeof p === 'string' ? { state: p } : p ?? {};
    return { key, state: 'todo', span: SPANS[key], ...extra } as Stage;
  });
}

export function row(id: string, patch: { area?: Partial<AreaRow['area']>; stages?: Stage[]; current_step?: number | null; unscheduled?: AreaRow['pipeline']['unscheduled'] } = {}): AreaRow {
  return {
    area: {
      id, title: `İçerik ${id}`, brief: 'Yeni kupaları tanıt', olay_id: null, opened_by: { kind: 'human' },
      hints: { formats: [], capability_ids: [] },
      status: { state: 'working', step: null, note: null, starts_at: '2026-10-01T09:00:00Z' },
      revision: 3, redo: null, open_requests: 0, created_at: '2026-10-01T09:00:00Z', updated_at: '2026-10-01T09:00:00Z',
      ...patch.area,
    },
    pipeline: { current_step: patch.current_step ?? null, stages: patch.stages ?? stages(), unscheduled: patch.unscheduled ?? [] },
  };
}

export const folder = (patch: Partial<TreeOut['genel']> = {}) => ({ files: 0, areas: 0, published: 0, waits: [], ...patch });

export function tree(patch: Partial<TreeOut> = {}): TreeOut {
  return {
    olays: [], genel: folder(), upcoming: [], analysis_queue: 0, areas: 0,
    waiting: { olay_confirmations: 0, shoot_requests: 0, content_approvals: 0, content_times: 0, problem_contents: 0 },
    ...patch,
  } as TreeOut;
}

export function view(patch: Partial<OlayViewOut> = {}): OlayViewOut {
  return {
    olay: null,
    contents: [], files: [], needs: [],
    ...patch,
  } as OlayViewOut;
}

export const intelligence = (patch: Record<string, unknown> = {}) => ({
  status: 'completed', description: 'Kupa, gün ışığında', group_name: null, date_source: 'unknown', attempts: 1,
  analyzed_revision: 1, last_error_code: null, analyzed_at: null, updated_at: '2026-10-02T09:00:00Z', manual_fields: [], ...patch,
});

export function queueItem(id: string, stage: QueueItem['stage'], patch: Record<string, unknown> = {}) {
  return { material: material(id, { binding: { kind: 'unfiled' }, share: null, title: `Dosya ${id}` }), intelligence: intelligence(stage === 'needs_filing' ? {} : { status: stage === 'failed' ? 'failed' : 'pending' }), unfiled: true, stage, ...patch };
}

export { olay, material };

/** The page's reads, with the shared fixtures for everything else. */
export function contentPageFetch(answers: FetchRoutes = {}, me?: unknown) {
  return mockFetch({
    ...studioAnswers,
    ...(me ? { 'GET /api/auth/me': me } : {}),
    'GET /api/agents': agents,
    'GET /api/strategy': strategyWithDraft,
    'GET /api/content/tree': tree(),
    'GET /api/content/areas': { areas: [], next_cursor: null, next_done_before: null },
    ...answers,
  });
}

/** The studio owner with only `permissions` of the page's three. */
export function meWith(permissions: string[]) {
  const session = studioAnswers['GET /api/auth/me'];
  const keep = session.memberships[0].permissions.filter((p: string) => !['materials.work', 'content.work', 'content.manage'].includes(p));
  return { ...session, memberships: [{ ...session.memberships[0], permissions: [...keep, ...permissions] }] };
}
