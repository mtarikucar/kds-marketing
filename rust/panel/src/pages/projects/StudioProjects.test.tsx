import { expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockFetch, renderAt, withStatus, type FetchRoutes } from '@/test/render';
import { material, materialsAnswers, repMe } from '@/test/materials';
import tr from '@/i18n/tr.json';

const p = tr.projects;
const source = material('m1', { title: 'Yeni ürün', binding: { kind: 'unbound' } });
const project = {
  id: 'p1',
  workspace_id: 'w',
  title: 'Lansman',
  brief: 'Yeni ürünü tanıt',
  revision: 4,
  archived: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  sources: [{ material_id: 'm1', revision: 2 }],
  requests: [],
  outputs: [],
  production_ids: [],
  invalidated_production_ids: [],
};
const detail = { project, materials: [source], productions: [], publications: [] };
function answers(extra: FetchRoutes = {}): FetchRoutes {
  return {
    ...materialsAnswers,
    'GET /api/studio/projects': { projects: [project], next_cursor: null },
    'GET /api/studio/projects/p1': detail,
    'GET /api/strategy': { approved: null, draft: null, gaps: [] },
    ...extra,
  };
}
const path = (view = '') => `/studio?tab=projects&project=p1${view ? `&projectView=${view}` : ''}`;

it('creates and navigates into a project before a strategy exists without reading gated overview', async () => {
  const calls = mockFetch(answers({ 'POST /api/studio/projects': project }));
  const { router } = renderAt('/studio?tab=projects');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: p.create }));
  await user.type(screen.getByLabelText(p.title), 'Lansman');
  await user.type(screen.getByLabelText(p.brief), 'Yeni ürünü tanıt');
  await user.click(screen.getByRole('button', { name: p.create }));
  await screen.findByTestId('production-project');
  expect(router.state.location.search).toBe('?tab=projects&project=p1');
  expect(calls.find((c) => c.method === 'POST' && c.path === '/api/studio/projects')?.body).toEqual({
    request_key: expect.any(String),
    title: 'Lansman',
    brief: 'Yeni ürünü tanıt',
  });
  expect(calls.some((c) => ['/api/studio/overview', '/api/work/pending'].includes(c.path))).toBe(false);
});

it('filters actual dynamic groups and attaches selected library material with the project revision', async () => {
  const second = material('m2', { title: 'Kahve yakın plan' });
  const calls = mockFetch(
    answers({
      'GET /api/studio/material-intelligence': [
        { material: second, intelligence: { group_name: 'Yeni menü', description: 'Kahve çekimi' } },
        { material: material('m3', { title: 'Ekip çekimi' }), intelligence: { group_name: 'Ekip' } },
      ],
      'POST /api/studio/projects/p1/materials': project,
    }),
  );
  renderAt(path('materials'));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: p.fromLibrary }));
  await screen.findByRole('checkbox', { name: /Kahve yakın plan/ });
  await user.selectOptions(screen.getByLabelText(tr.materials.intelligence.group), 'Yeni menü');
  expect(screen.queryByRole('checkbox', { name: /Ekip çekimi/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: /Kahve yakın plan/ }));
  await user.click(screen.getByRole('button', { name: 'Seçilenleri ekle (1)' }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/materials'))?.body).toEqual({
      expected_revision: 4,
      add: ['m2'],
      remove: [],
    }),
  );
});

it('refreshes changed source snapshots without detaching them', async () => {
  const calls = mockFetch(
    answers({
      'GET /api/studio/projects/p1': { ...detail, materials: [{ ...source, revision: 3 }] },
      'POST /api/studio/projects/p1/materials': project,
    }),
  );
  renderAt(path('materials'));
  await userEvent.click(await screen.findByRole('button', { name: p.refreshSources }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/materials'))?.body).toEqual({
      expected_revision: 4,
      add: ['m1'],
      remove: [],
    }),
  );
});

it('requires a real material delivery to resolve a request', async () => {
  const request = {
    id: 'r1',
    text: 'Ürün yakın çekimi',
    status: 'open',
    material_ids: [],
    created_at: project.created_at,
    resolved_at: null,
  };
  const calls = mockFetch(
    answers({
      'GET /api/studio/projects/p1': { ...detail, project: { ...project, requests: [request] } },
      'PATCH /api/studio/projects/p1/requests/r1': project,
    }),
  );
  renderAt(path());
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: p.resolveRequest }));
  expect(screen.getByRole('button', { name: p.confirmDelivery })).toBeDisabled();
  await user.click(screen.getByRole('checkbox', { name: 'Yeni ürün' }));
  await user.click(screen.getByRole('button', { name: p.confirmDelivery }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      expected_revision: 4,
      status: 'done',
      material_ids: ['m1'],
    }),
  );
});

it('creates a derivative request from selected sources and explains agent waiting honestly', async () => {
  const calls = mockFetch(
    answers({ 'POST /api/studio/projects/p1/productions': { project, production: {} } }),
  );
  renderAt(path('production'));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: p.newProduction }));
  await user.selectOptions(screen.getByLabelText(tr.materials.production.kind), 'crop');
  await user.type(screen.getByLabelText(tr.materials.production.instructions), 'Dikey 9:16 kırp');
  await user.click(screen.getByRole('checkbox', { name: /Yeni ürün/ }));
  expect(screen.getByText(p.productionWaiting)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: tr.materials.production.submit }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/productions'))?.body).toEqual({
      request_key: expect.any(String),
      expected_revision: 4,
      kind: 'crop',
      instructions: 'Dikey 9:16 kırp',
      material_ids: ['m1'],
    }),
  );
});

it('retains an edited brief after a revision conflict and never silently overwrites it', async () => {
  mockFetch(
    answers({
      'PATCH /api/studio/projects/p1': withStatus(409, {
        code: 'CONFLICT',
        message: 'project revision changed',
        details: {},
      }),
    }),
  );
  renderAt(path());
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: p.editBrief }));
  await user.clear(screen.getByLabelText(p.brief));
  await user.type(screen.getByLabelText(p.brief), 'Korunması gereken taslak');
  await user.click(screen.getByRole('button', { name: tr.common.save }));
  await screen.findByText(p.conflictHelp);
  expect(screen.getByLabelText(p.brief)).toHaveValue('Korunması gereken taslak');
});

it('does not offer project mutations to a studio reader', async () => {
  mockFetch(answers({ 'GET /api/auth/me': repMe }));
  renderAt('/studio?tab=projects');
  await screen.findByTestId('studio-projects');
  expect(screen.queryByRole('button', { name: p.create })).not.toBeInTheDocument();
});

const output = {
  id: 'o1',
  title: 'Tanıtım gönderisi',
  format: 'feed_post',
  capability_id: 'c1',
  target_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
  slot_id: null,
};
const hypothesis = {
  id: 'h1',
  title: 'Ürün hikâyesi',
  state: 'kept',
  cadence: { organic: { content_types: [{ key: 'product' }] } },
};

it('saves a draft target without scheduling a canonical publication', async () => {
  const calls = mockFetch(answers({ 'PATCH /api/studio/projects/p1': project }));
  renderAt(path('publications'));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: p.addOutput }));
  await user.type(screen.getByLabelText(p.outputTitle), 'Tanıtım gönderisi');
  await user.click(screen.getByRole('button', { name: p.saveOutput }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      expected_revision: 4,
      outputs: [{ title: 'Tanıtım gönderisi', format: 'feed_post', target_at: null, capability_id: null }],
    }),
  );
  expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/schedule'))).toBe(false);
});

it('schedules selected project materials through the canonical posting bridge', async () => {
  const calls = mockFetch(
    answers({
      'GET /api/studio/projects/p1': { ...detail, project: { ...project, outputs: [output] } },
      'GET /api/strategy': { approved: { hypotheses: [hypothesis] }, draft: null, gaps: [] },
      'POST /api/studio/projects/p1/outputs/o1/schedule': { project, publication: {} },
    }),
  );
  renderAt(path('publications'));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: p.schedule }));
  await user.click(screen.getByRole('checkbox', { name: /Yeni ürün/ }));
  const form = screen.getByRole('heading', { name: p.scheduleTitle }).closest('form')!;
  await user.click(within(form).getByRole('button', { name: p.schedule }));
  await waitFor(() =>
    expect(calls.find((c) => c.path.endsWith('/schedule'))?.body).toEqual({
      request_key: expect.any(String),
      expected_revision: 4,
      hypothesis_id: 'h1',
      material_ids: ['m1'],
    }),
  );
});

it('prepares a real scheduled piece without leaving the production workspace', async () => {
  const slot = {
    id: 's1',
    chain: { workspace_id: 'w', born_version_id: 'v1', hypothesis_id: 'h1', arm_id: 'a1' },
    capability_id: 'c1',
    scheduled_at: output.target_at,
    state: 'planned',
    revision: 7,
  };
  const calls = mockFetch(
    answers({
      'GET /api/studio/projects/p1': {
        ...detail,
        project: { ...project, outputs: [{ ...output, slot_id: 's1' }] },
        publications: [{ output_id: 'o1', slot, post: null }],
      },
      'GET /api/studio/slots/s1': {
        slot,
        piece: { text: '', media: [], adaptations: {} },
        hypothesis,
        brand_rules: { identity: { voice: 'Sade' }, prohibitions: [] },
        attempts: [],
        measurements: [],
      },
      'GET /api/studio/slots/s1/materials': {
        slot_id: 's1',
        scheduled_at: output.target_at,
        need: {},
        candidates: [
          {
            material_id: 'm1',
            file_id: 'file-m1',
            mime: 'image/jpeg',
            subject: { kind: 'generic' },
            role: 'anchor',
            matches_need: true,
          },
        ],
        refused: [],
      },
      'GET /api/studio/materials': [source],
      'POST /api/studio/slots/s1/piece': {},
    }),
  );
  const { router } = renderAt(path('publications'));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: p.preparePublication }));
  const editor = await screen.findByTestId('slot-detail');
  await user.type(await within(editor).findByLabelText('İçerik metni'), 'Yeni ürünümüzle tanışın.');
  await user.click(await within(editor).findByRole('checkbox', { name: /Yeni ürün/ }));
  await user.click(within(editor).getByRole('button', { name: 'İçeriği teslim et' }));
  await waitFor(() =>
    expect(calls.find((c) => c.path.endsWith('/piece'))?.body).toMatchObject({
      expected_revision: 7,
      text: 'Yeni ürünümüzle tanışın.',
      media: [{ kind: 'file', id: 'file-m1' }],
      subject: { kind: 'generic' },
    }),
  );
  expect(router.state.location.search).toBe('?tab=projects&project=p1&projectView=publications');
});

it('retries project attachment after upload without duplicating the library material request', async () => {
  const added = material('m2', { file_id: 'file-new', title: 'Yeni çekim' });
  const routes = answers({
    'POST /api/studio/files': { id: 'file-new', mime: 'image/jpeg', filename: 'urun.jpg' },
    'POST /api/studio/materials': { material: added, olay_suggestions: [] },
    'POST /api/studio/projects/p1/materials': withStatus(409, {
      code: 'CONFLICT',
      message: 'project revision changed',
      details: {},
    }),
  });
  const calls = mockFetch(routes);
  renderAt(path('materials'));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: p.upload }));
  await user.upload(
    await screen.findByLabelText('Galeriden seç', { selector: 'input' }),
    new File(['x'], 'urun.jpg', { type: 'image/jpeg' }),
  );
  await screen.findByText('Yüklendi');
  await user.click(screen.getByRole('button', { name: '1 materyali ekle' }));
  await screen.findByText('Eklenemedi');
  expect(screen.queryByText('1 materyal eklendi.')).not.toBeInTheDocument();
  routes['GET /api/studio/projects/p1'] = { ...detail, project: { ...project, revision: 7 } };
  routes['POST /api/studio/projects/p1/materials'] = { ...project, revision: 8 };
  await user.click(screen.getByRole('button', { name: '1 materyali ekle' }));
  await screen.findByText('1 materyal eklendi.');
  const additions = calls.filter((c) => c.method === 'POST' && c.path === '/api/studio/materials');
  expect(additions).toHaveLength(2);
  expect(additions[0].body).toEqual(additions[1].body);
  expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/studio/files')).toHaveLength(1);
  expect(
    calls.filter((c) => c.method === 'POST' && c.path === '/api/studio/projects/p1/materials').at(-1)?.body,
  ).toEqual({ expected_revision: 7, add: ['m2'], remove: [] });
});

it('allows current derivative outputs as new editing sources but excludes invalidated outputs', async () => {
  const current = material('m2', { title: 'Dikey kapak' });
  const old = material('m3', { title: 'Eski afiş' });
  const jobs = [
    {
      id: 'j1',
      kind: 'crop',
      status: 'completed',
      instructions: 'Dikey kapak',
      output_material_id: 'm2',
      sources: [{ material_id: 'm1', revision: 2 }],
    },
    {
      id: 'j2',
      kind: 'poster',
      status: 'completed',
      instructions: 'Eski afiş',
      output_material_id: 'm3',
      sources: [{ material_id: 'm1', revision: 1 }],
    },
  ];
  const calls = mockFetch(
    answers({
      'GET /api/studio/projects/p1': {
        ...detail,
        materials: [source, current, old],
        productions: jobs,
        project: { ...project, production_ids: ['j1', 'j2'], invalidated_production_ids: ['j2'] },
      },
      'POST /api/studio/projects/p1/productions': { project, production: {} },
    }),
  );
  renderAt(path('production'));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: p.newProduction }));
  expect(screen.queryByRole('checkbox', { name: /Eski afiş/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: /Dikey kapak/ }));
  await user.type(screen.getByLabelText(tr.materials.production.instructions), 'Kare kadraj');
  await user.click(screen.getByRole('button', { name: tr.materials.production.submit }));
  await waitFor(() =>
    expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/productions'))?.body).toMatchObject({
      kind: 'crop',
      material_ids: ['m2'],
    }),
  );
});
