import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { api, MemoryStorage, png, startTestApp, untilDone, waitFor, type TestApp } from './helpers.ts';

const threadStarts = (t: TestApp) => t.sent().filter((m) => m.method === 'thread/start');
const turnStarts = (t: TestApp) => t.sent().filter((m) => m.method === 'turn/start');
const interrupts = (t: TestApp) => t.sent().filter((m) => m.method === 'turn/interrupt');

describe('A3 generate → image → R2 → url', () => {
  let t: TestApp;
  before(async () => { t = await startTestApp(); });
  after(() => t.close());

  test('a completed imageGeneration is cropped, uploaded and reported with url/width/height', async () => {
    const r = await api(t.base, '/generate', { body: { prompt: 'red apple on white', aspectRatio: '9:16', workspaceId: 'ws-123' } });
    assert.equal(r.status, 202);
    assert.deepEqual(Object.keys(r.body).sort(), ['jobId', 'position', 'status']);
    const job = await untilDone(t.base, r.body.jobId);
    assert.equal(job.status, 'COMPLETED', JSON.stringify(job));
    const key = `codex-media/ws-123/${r.body.jobId}.png`;
    assert.equal(job.url, `https://media.test/${key}`);
    assert.equal(job.mime, 'image/png');
    assert.equal(job.width, 1080);
    assert.equal(job.height, 1920);
    assert.match(job.revisedPrompt, /^Revised: /);
    assert.equal(typeof job.durationMs, 'number');
    const stored = t.storage.objects.get(key);
    assert.ok(stored, 'object uploaded under the contract key');
    assert.equal(stored.contentType, 'image/png');
    const meta = await sharp(stored.body).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['png', 1080, 1920]);
    // the job's work directory is gone
    assert.deepEqual(readdirSync(t.app.config.workRoot), []);
  });

  test('turn input carries the template with aspect ratio and framing; no workspace → "_" key prefix', async () => {
    const r = await api(t.base, '/generate', { body: { prompt: 'a cat', aspectRatio: '4:5' } });
    const job = await untilDone(t.base, r.body.jobId);
    assert.equal(job.url, `https://media.test/codex-media/_/${r.body.jobId}.png`);
    const turn = turnStarts(t).at(-1)!;
    assert.deepEqual(turn.params.input, [{ type: 'text', text: 'a cat\n\nOutput: exactly one image, aspect ratio 4:5 (1080x1350 framing). ', text_elements: [] }]);
  });

  test('aspect ratio defaults to 1:1', async () => {
    const r = await api(t.base, '/generate', { body: { prompt: 'a dog' } });
    const job = await untilDone(t.base, r.body.jobId);
    assert.deepEqual([job.width, job.height], [1080, 1080]);
  });
});

describe('A3 savedPath and references', () => {
  test('savedPath is read in preference to base64 and deleted afterwards', async () => {
    const saved = mkdtempSync(join(tmpdir(), 'codex-saved-'));
    const t = await startTestApp({ fakeEnv: { FAKE_SAVED_DIR: saved } });
    try {
      const r = await api(t.base, '/generate', { body: { prompt: 'apple' } });
      const job = await untilDone(t.base, r.body.jobId);
      assert.equal(job.status, 'COMPLETED');
      assert.deepEqual(readdirSync(saved), [], 'the image and its now-empty thread folder are removed');
    } finally { await t.close(); }
  });

  test('references are downloaded into the job dir and passed as localImage before the text', async () => {
    const ref = await png(64, 64);
    const seen: string[] = [];
    const fakeFetch = (async (url: string | URL) => {
      seen.push(String(url));
      return new Response(new Uint8Array(ref), { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(ref.length) } });
    }) as typeof fetch;
    const t = await startTestApp({ fetch: fakeFetch });
    try {
      const r = await api(t.base, '/generate', { body: { prompt: 'same figurine on a desk', aspectRatio: '9:16', referenceImages: ['https://media.test/social/ws/a.png', 'https://media.test/social/ws/b.png'] } });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      const job = await untilDone(t.base, r.body.jobId);
      assert.equal(job.status, 'COMPLETED');
      assert.deepEqual(seen, ['https://media.test/social/ws/a.png', 'https://media.test/social/ws/b.png']);
      const input = turnStarts(t).at(-1)!.params.input;
      assert.equal(input.length, 3);
      assert.equal(input[0].type, 'localImage');
      assert.match(input[0].path, new RegExp(`${r.body.jobId}[\\\\/]ref-1\\.png$`));
      assert.match(input[1].path, /ref-2\.png$/);
      assert.equal(input[2].text, 'same figurine on a desk\n\nOutput: exactly one image, aspect ratio 9:16 (1080x1920 framing). Use the attached reference image(s) as the subject; keep it recognisable.');
      assert.deepEqual(readdirSync(t.app.config.workRoot), []);
    } finally { await t.close(); }
  });

  for (const [name, response] of [
    ['404 from the origin', () => new Response('no', { status: 404 })],
    ['wrong content type', () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['over the size limit', () => new Response(new Uint8Array(2048), { status: 200, headers: { 'content-type': 'image/png' } })],
  ] as const) {
    test(`reference ${name} → 400 REFERENCE_FETCH_FAILED and nothing queued`, async () => {
      const t = await startTestApp({ fetch: (async () => response()) as typeof fetch, config: { maxRefBytes: 1024 } });
      try {
        const r = await api(t.base, '/generate', { body: { prompt: 'x', referenceImages: ['https://media.test/a.png'] } });
        assert.equal(r.status, 400);
        assert.equal(r.body.code, 'REFERENCE_FETCH_FAILED');
        assert.equal(threadStarts(t).length, 0);
        assert.deepEqual(readdirSync(t.app.config.workRoot), []);
      } finally { await t.close(); }
    });
  }
});

describe('A4 failures', () => {
  let t: TestApp;
  before(async () => { t = await startTestApp({ config: { jobTimeoutMs: 400 } }); });
  after(() => t.close());

  const run = async (prompt: string) => untilDone(t.base, (await api(t.base, '/generate', { body: { prompt } })).body.jobId);

  test('imageGeneration failure → FAILED CONTENT_BLOCKED', async () => {
    const job = await run('[scenario:blocked] x');
    assert.equal(job.status, 'FAILED');
    assert.equal(job.code, 'CONTENT_BLOCKED');
    assert.ok(job.message);
  });

  test('turn ends without an image → FAILED NO_IMAGE', async () => {
    const job = await run('[scenario:noimage] x');
    assert.deepEqual([job.status, job.code], ['FAILED', 'NO_IMAGE']);
  });

  test('a commandExecution item → FAILED POLICY_VIOLATION and turn/interrupt', async () => {
    const before = interrupts(t).length;
    const job = await run('[scenario:command] x');
    assert.deepEqual([job.status, job.code], ['FAILED', 'POLICY_VIOLATION']);
    assert.equal(interrupts(t).length, before + 1);
  });

  test('no result within the job timeout → FAILED TIMEOUT and turn/interrupt', async () => {
    const before = interrupts(t).length;
    const job = await run('[scenario:hang] x');
    assert.deepEqual([job.status, job.code], ['FAILED', 'TIMEOUT']);
    assert.equal(interrupts(t).length, before + 1);
  });

  test('app-server exits mid-job → FAILED CODEX_PROCESS_EXITED, then it is restarted', async () => {
    const job = await run('[scenario:crash] x');
    assert.deepEqual([job.status, job.code], ['FAILED', 'CODEX_PROCESS_EXITED']);
    await waitFor(() => t.app.codex.state === 'ready');
    const ok = await run('apple after restart');
    assert.equal(ok.status, 'COMPLETED');
  });

  test('R2 upload is retried 3 times, then FAILED UPLOAD_FAILED', async () => {
    const storage = new MemoryStorage();
    const t2 = await startTestApp({ storage, config: { uploadRetryDelayMs: 1 } });
    try {
      storage.failures = 2;
      const ok = await untilDone(t2.base, (await api(t2.base, '/generate', { body: { prompt: 'x' } })).body.jobId);
      assert.equal(ok.status, 'COMPLETED');
      assert.equal(storage.attempts, 3);
      storage.failures = 3;
      storage.attempts = 0;
      const bad = await untilDone(t2.base, (await api(t2.base, '/generate', { body: { prompt: 'x' } })).body.jobId);
      assert.deepEqual([bad.status, bad.code], ['FAILED', 'UPLOAD_FAILED']);
      assert.equal(storage.attempts, 3);
    } finally { await t2.close(); }
  });
});

describe('A5 thread safety settings and server requests', () => {
  let t: TestApp;
  before(async () => { t = await startTestApp({ config: { model: 'gpt-test' } }); });
  after(() => t.close());

  test('thread/start locks the agent down (§1.6)', async () => {
    const r = await api(t.base, '/generate', { body: { prompt: 'apple' } });
    await untilDone(t.base, r.body.jobId);
    const p = threadStarts(t).at(-1)!.params;
    assert.equal(p.ephemeral, true);
    assert.equal(p.approvalPolicy, 'untrusted');
    assert.equal(p.sandbox, 'read-only');
    assert.equal(p.model, 'gpt-test');
    assert.match(p.cwd, new RegExp(`${r.body.jobId}$`));
    assert.deepEqual(p.config, {
      'features.image_generation': true,
      'features.apps': false,
      'features.multi_agent': false,
      'features.plugins': false,
      'features.memories': false,
      web_search: 'disabled',
      'mcp_servers.office.enabled': false,
      'mcp_servers.github.enabled': false,
      'plugins.figma@x.enabled': false,
    });
    assert.match(p.developerInstructions, /image generation backend/);
    assert.match(p.developerInstructions, /Never run commands/);
  });

  test('every approval / elicitation / user-input request from the server is declined', async () => {
    const r = await api(t.base, '/generate', { body: { prompt: '[scenario:approval] apple' } });
    const job = await untilDone(t.base, r.body.jobId);
    assert.equal(job.status, 'COMPLETED');
    const replies = t.sent().filter((m) => m.id > 1000 && !m.method).map((m) => m.result);
    assert.deepEqual(replies, [
      { decision: 'decline' },
      { decision: 'decline' },
      { permissions: {}, scope: 'turn' },
      { action: 'decline', content: null },
      { answers: {} },
    ]);
  });

  test('completed jobs expire after the TTL → 404', async () => {
    const t2 = await startTestApp({ config: { jobTtlMs: 50 } });
    try {
      const r = await api(t2.base, '/generate', { body: { prompt: 'apple' } });
      await untilDone(t2.base, r.body.jobId);
      await new Promise((res) => setTimeout(res, 80));
      assert.equal((await api(t2.base, `/jobs/${r.body.jobId}`)).status, 404);
    } finally { await t2.close(); }
  });

  test('base64 never reaches the log', async () => {
    const lines: string[] = [];
    const t2 = await startTestApp({ config: { log: (l: string) => lines.push(l) } });
    try {
      const r = await api(t2.base, '/generate', { body: { prompt: 'apple '.repeat(100) } });
      await untilDone(t2.base, r.body.jobId);
      const all = lines.join('\n');
      assert.ok(all.includes(r.body.jobId));
      assert.ok(!/iVBORw0KGgo/.test(all), 'no PNG base64 in logs');
      assert.ok(lines.every((l) => l.length < 1000));
    } finally { await t2.close(); }
  });
});

