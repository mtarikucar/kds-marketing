import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { api, startTestApp, untilDone, waitFor, type TestApp } from './helpers.ts';

describe('A1 auth and health', () => {
  let t: TestApp;
  before(async () => { t = await startTestApp(); });
  after(() => t.close());

  test('GET /health needs no secret and reports codex state, queue and weekly quota', async () => {
    const r = await api(t.base, '/health', { secret: null });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, codex: 'ready', queue: 0, running: 0, weeklyUsedPercent: 1 });
  });

  test('missing or wrong secret → 401 UNAUTHORIZED on every other route', async () => {
    for (const r of [
      await api(t.base, '/generate', { body: { prompt: 'x' }, secret: null }),
      await api(t.base, '/generate', { body: { prompt: 'x' }, secret: 'wrong' }),
      await api(t.base, '/jobs/cm_x', { secret: null }),
    ]) {
      assert.equal(r.status, 401);
      assert.equal(r.body.code, 'UNAUTHORIZED');
    }
  });

  test('unknown job → 404 JOB_NOT_FOUND; unknown route → 404', async () => {
    const r = await api(t.base, '/jobs/cm_nope');
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'JOB_NOT_FOUND');
    assert.equal((await api(t.base, '/nope')).status, 404);
  });
});

describe('A2 body validation', () => {
  let t: TestApp;
  before(async () => { t = await startTestApp({ config: { refHosts: ['media.test', 'cdn.example.com'] } }); });
  after(() => t.close());

  const cases: Array<[string, unknown, string]> = [
    ['empty prompt', { prompt: '   ' }, 'prompt'],
    ['missing prompt', {}, 'prompt'],
    ['prompt too long', { prompt: 'a'.repeat(4001) }, 'prompt'],
    ['aspect ratio not in list', { prompt: 'x', aspectRatio: '2:1' }, 'aspectRatio'],
    ['more than 4 references', { prompt: 'x', referenceImages: Array.from({ length: 5 }, (_, i) => `https://media.test/${i}.png`) }, 'referenceImages'],
    ['http reference', { prompt: 'x', referenceImages: ['http://media.test/a.png'] }, 'referenceImages[0]'],
    ['reference on a host that is not allowed', { prompt: 'x', referenceImages: ['https://evil.example.org/a.png'] }, 'referenceImages[0]'],
    ['workspaceId with path characters', { prompt: 'x', workspaceId: '../etc' }, 'workspaceId'],
    ['clientRef too long', { prompt: 'x', clientRef: 'c'.repeat(101) }, 'clientRef'],
  ];
  for (const [name, body, field] of cases) {
    test(`${name} → 400 VALIDATION_FAILED naming ${field}`, async () => {
      const r = await api(t.base, '/generate', { body });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, 'VALIDATION_FAILED');
      assert.ok(r.body.details.some((d: { field: string }) => d.field === field), JSON.stringify(r.body.details));
    });
  }

  test('invalid JSON → 400 VALIDATION_FAILED', async () => {
    const r = await api(t.base, '/generate', { raw: '{nope' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'VALIDATION_FAILED');
  });

  test('body over 64 KB → 413 PAYLOAD_TOO_LARGE', async () => {
    const r = await api(t.base, '/generate', { raw: JSON.stringify({ prompt: 'x', pad: 'p'.repeat(70_000) }) });
    assert.equal(r.status, 413);
    assert.equal(r.body.code, 'PAYLOAD_TOO_LARGE');
  });

  test('a reference on an extra allowed host passes validation', async () => {
    const r = await api(t.base, '/generate', { body: { prompt: 'x', referenceImages: ['https://cdn.example.com/a.png'] } });
    assert.notEqual(r.body?.code, 'VALIDATION_FAILED');
  });
});

describe('A6 concurrency, queue and idempotency', () => {
  let t: TestApp;
  before(async () => { t = await startTestApp({ config: { concurrency: 2, maxQueue: 20, jobTimeoutMs: 60_000 } }); });
  after(() => t.close());

  test('2 run at once, 20 wait in FIFO order, the next request → 429 QUEUE_FULL', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 22; i++) {
      const r = await api(t.base, '/generate', { body: { prompt: `[scenario:hang] job ${i}` } });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      assert.equal(r.body.status, 'QUEUED');
      assert.match(r.body.jobId, /^cm_[0-9A-Z]{18}$/);
      ids.push(r.body.jobId);
    }
    await waitFor(async () => (await api(t.base, '/health', { secret: null })).body.running === 2);
    const health = (await api(t.base, '/health', { secret: null })).body;
    assert.equal(health.queue, 20);
    assert.equal((await api(t.base, `/jobs/${ids[0]}`)).body.status, 'RUNNING');
    assert.equal((await api(t.base, `/jobs/${ids[1]}`)).body.status, 'RUNNING');
    assert.equal((await api(t.base, `/jobs/${ids[2]}`)).body.status, 'QUEUED');
    const full = await api(t.base, '/generate', { body: { prompt: 'one too many' } });
    assert.equal(full.status, 429);
    assert.equal(full.body.code, 'QUEUE_FULL');
  });

  test('the same clientRef returns the same jobId', async () => {
    const t2 = await startTestApp();
    try {
      const a = await api(t2.base, '/generate', { body: { prompt: 'apple', clientRef: 'asset-1' } });
      const b = await api(t2.base, '/generate', { body: { prompt: 'apple', clientRef: 'asset-1' } });
      const c = await api(t2.base, '/generate', { body: { prompt: 'apple', clientRef: 'asset-2' } });
      assert.equal(a.status, 202);
      assert.equal(b.status, 202);
      assert.equal(b.body.jobId, a.body.jobId);
      assert.notEqual(c.body.jobId, a.body.jobId);
      await untilDone(t2.base, a.body.jobId);
      await untilDone(t2.base, c.body.jobId);
      assert.equal(t2.storage.objects.size, 2, 'only two generations ran');
    } finally { await t2.close(); }
  });
});

describe('A7 session and quota', () => {
  test('no ChatGPT login → /health auth_required and POST /generate 503 CODEX_AUTH_REQUIRED', async () => {
    const t = await startTestApp({ fakeEnv: { FAKE_ACCOUNT: 'none' } });
    try {
      assert.equal((await api(t.base, '/health', { secret: null })).body.codex, 'auth_required');
      const r = await api(t.base, '/generate', { body: { prompt: 'apple' } });
      assert.equal(r.status, 503);
      assert.equal(r.body.code, 'CODEX_AUTH_REQUIRED');
    } finally { await t.close(); }
  });

  test('weekly usage over the ceiling → 503 CODEX_QUOTA_EXHAUSTED with resetsAt', async () => {
    const t = await startTestApp({ fakeEnv: { FAKE_USED_PERCENT: '61' }, config: { quotaCeilingPercent: 60 } });
    try {
      const r = await api(t.base, '/generate', { body: { prompt: 'apple' } });
      assert.equal(r.status, 503);
      assert.equal(r.body.code, 'CODEX_QUOTA_EXHAUSTED');
      assert.equal(r.body.resetsAt, new Date(1793000000 * 1000).toISOString());
      assert.equal((await api(t.base, '/health', { secret: null })).body.weeklyUsedPercent, 61);
    } finally { await t.close(); }
  });

  test('usage limit hit during a turn → job FAILED CODEX_QUOTA_EXHAUSTED, then submits 503', async () => {
    const t = await startTestApp();
    try {
      const r = await api(t.base, '/generate', { body: { prompt: '[scenario:quota] apple' } });
      const job = await untilDone(t.base, r.body.jobId);
      assert.equal(job.status, 'FAILED');
      assert.equal(job.code, 'CODEX_QUOTA_EXHAUSTED');
      const next = await api(t.base, '/generate', { body: { prompt: 'apple' } });
      assert.equal(next.status, 503);
      assert.equal(next.body.code, 'CODEX_QUOTA_EXHAUSTED');
      assert.ok(next.body.resetsAt);
    } finally { await t.close(); }
  });

  test('app-server cannot start → /health down and POST 503 CODEX_UNAVAILABLE', async () => {
    const t = await startTestApp({ config: { codexCommand: [process.execPath, '-e', 'process.exit(1)'], restartMinMs: 10_000, restartMaxMs: 10_000 }, waitReady: false });
    try {
      await waitFor(() => t.app.codex.state === 'down');
      assert.equal((await api(t.base, '/health', { secret: null })).body.codex, 'down');
      const r = await api(t.base, '/generate', { body: { prompt: 'apple' } });
      assert.equal(r.status, 503);
      assert.equal(r.body.code, 'CODEX_UNAVAILABLE');
    } finally { await t.close(); }
  });
});
