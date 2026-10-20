import { createServer, type Server } from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { AppConfig } from './config.js';
import { CodexClient, type UserInput } from './codex.js';
import { HttpError, JobError } from './errors.js';
import { isAuthorized, jobView, readJson, sendError, sendJson, validateGenerate } from './http.js';
import { fitToAspect, TARGET_SIZE } from './image.js';
import { JobQueue, newJobId, type Job, type JobOutput } from './jobs.js';
import { downloadReferences } from './refs.js';
import { DryRunStorage, KEY_PREFIX, R2Storage, type Storage } from './storage.js';

export interface App {
  readonly config: AppConfig;
  readonly codex: CodexClient;
  readonly queue: JobQueue;
  readonly server: Server;
  listen(): Promise<number>;
  close(): Promise<void>;
}

const clip = (s: string | null | undefined, n = 200) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : undefined);

export function promptText(prompt: string, ratio: keyof typeof TARGET_SIZE, hasRefs: boolean): string {
  const [w, h] = TARGET_SIZE[ratio];
  return `${prompt}\n\nOutput: exactly one image, aspect ratio ${ratio} (${w}x${h} framing). `
    + (hasRefs ? 'Use the attached reference image(s) as the subject; keep it recognisable.' : '');
}

function defaultStorage(config: AppConfig): Storage {
  if (config.r2) return new R2Storage(config.r2);
  if (config.dryRunDir) return new DryRunStorage(config.dryRunDir);
  throw new Error('R2 yapılandırılmamış: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL (ya da yerel deneme için CODEX_MEDIA_R2_DRYRUN=1)');
}

export function createApp(config: AppConfig, deps: { storage?: Storage; fetch?: typeof fetch } = {}): App {
  const storage = deps.storage ?? defaultStorage(config);
  const fetchFn = deps.fetch ?? fetch;
  const log = (event: string, fields: Record<string, unknown> = {}) =>
    config.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
  let closing = false;

  mkdirSync(config.workRoot, { recursive: true });
  const codex = new CodexClient({
    command: config.codexCommand,
    shell: config.codexShell,
    env: config.codexEnv,
    cwd: config.workRoot,
    model: config.model,
    rpcTimeoutMs: config.rpcTimeoutMs,
    restartMinMs: config.restartMinMs,
    restartMaxMs: config.restartMaxMs,
    quotaCeilingPercent: config.quotaCeilingPercent,
    log,
  });

  async function upload(key: string, body: Buffer): Promise<string> {
    let last: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await storage.upload(key, body, 'image/png'); } catch (err) {
        last = err;
        log('job.upload_retry', { key, attempt, error: (err as Error).message });
        if (attempt < 3) await new Promise((r) => setTimeout(r, config.uploadRetryDelayMs * attempt));
      }
    }
    throw new JobError('UPLOAD_FAILED', `R2 upload failed after 3 attempts: ${(last as Error)?.message ?? 'unknown'}`);
  }

  async function run(job: Job): Promise<JobOutput> {
    if (closing) throw new JobError('CODEX_UNAVAILABLE', 'codex-media is shutting down.');
    const dir = join(config.workRoot, job.id);
    const { request } = job;
    let savedPath: string | null = null;
    log('job.started', { jobId: job.id, workspaceId: request.workspaceId, aspectRatio: request.aspectRatio, refs: job.refPaths.length, prompt: clip(request.prompt) });
    try {
      mkdirSync(dir, { recursive: true });
      const input: UserInput[] = [
        ...job.refPaths.map((path) => ({ type: 'localImage' as const, path })),
        { type: 'text', text: promptText(request.prompt, request.aspectRatio, job.refPaths.length > 0), text_elements: [] },
      ];
      const image = await codex.generate({ jobId: job.id, cwd: dir, input, timeoutMs: config.jobTimeoutMs });
      savedPath = image.savedPath;
      let raw: Buffer | null = null;
      if (savedPath) raw = await readFile(savedPath).catch(() => null);
      if (!raw && image.base64) raw = Buffer.from(image.base64, 'base64');
      if (!raw?.length) throw new JobError('NO_IMAGE', 'The image item carried no data.');
      let fitted;
      try { fitted = await fitToAspect(raw, request.aspectRatio); } catch (err) {
        throw new JobError('NO_IMAGE', `The generated image could not be read: ${(err as Error).message}`);
      }
      const key = `${KEY_PREFIX}${request.workspaceId ?? '_'}/${job.id}.png`;
      const url = await upload(key, fitted.buffer);
      log('job.completed', { jobId: job.id, key, width: fitted.width, height: fitted.height, revisedPrompt: clip(image.revisedPrompt) });
      return { url, mime: 'image/png', width: fitted.width, height: fitted.height, revisedPrompt: image.revisedPrompt };
    } catch (err) {
      const e = err instanceof JobError ? err : new JobError('INTERNAL', (err as Error).message);
      log('job.failed', { jobId: job.id, workspaceId: request.workspaceId, code: e.code, message: clip(e.message) });
      throw e;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      // Codex keeps a copy under CODEX_HOME/generated_images/<thread>/; we do not.
      if (savedPath) {
        await rm(savedPath, { force: true }).catch(() => {});
        await rmdir(dirname(savedPath)).catch(() => {}); // only succeeds once the thread folder is empty
      }
    }
  }

  const queue = new JobQueue({
    concurrency: config.concurrency,
    maxQueue: config.maxQueue,
    ttlMs: config.jobTtlMs,
    idempotencyMs: config.idempotencyMs,
    run,
  });

  async function generate(body: unknown): Promise<{ status: number; body: unknown }> {
    const request = validateGenerate(body, config.refHosts);
    const existing = queue.findByClientRef(request.clientRef);
    if (existing) return { status: 202, body: { jobId: existing.id, status: existing.status } };

    if (codex.state === 'auth_required') await codex.refreshAccount();
    if (codex.state === 'auth_required') throw new HttpError(503, 'CODEX_AUTH_REQUIRED', 'ChatGPT login is missing on the codex-media host; run `codex login --device-auth`.');
    if (codex.state !== 'ready') throw new HttpError(503, 'CODEX_UNAVAILABLE', `codex app-server is ${codex.state}.`);
    const quota = codex.quotaBlock();
    if (quota) throw new HttpError(503, 'CODEX_QUOTA_EXHAUSTED', 'Codex weekly quota for image generation is used up.', { resetsAt: quota.resetsAt });
    if (!queue.hasRoom()) throw new HttpError(429, 'QUEUE_FULL', `Queue is full (${config.maxQueue} waiting).`);

    const id = newJobId();
    const dir = join(config.workRoot, id);
    mkdirSync(dir, { recursive: true });
    let refPaths: string[] = [];
    try {
      refPaths = await downloadReferences(request.referenceImages, dir, { fetch: fetchFn, maxBytes: config.maxRefBytes });
      if (!queue.hasRoom()) throw new HttpError(429, 'QUEUE_FULL', `Queue is full (${config.maxQueue} waiting).`);
    } catch (err) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    const { job, position } = queue.submit(id, request, refPaths);
    log('job.queued', { jobId: id, workspaceId: request.workspaceId, clientRef: request.clientRef, position });
    return { status: 202, body: { jobId: job.id, status: 'QUEUED', position } };
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://codex-media');
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true, codex: codex.state, queue: queue.queued, running: queue.running, weeklyUsedPercent: codex.weeklyUsedPercent });
      }
      if (!isAuthorized(req, config.secret)) throw new HttpError(401, 'UNAUTHORIZED', 'Missing or wrong bearer secret.');
      if (req.method === 'POST' && url.pathname === '/generate') {
        const out = await generate(await readJson(req));
        return sendJson(res, out.status, out.body);
      }
      const m = /^\/jobs\/([A-Za-z0-9_]{1,64})$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        const job = queue.get(m[1]!);
        if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', 'Unknown or expired job.');
        return sendJson(res, 200, jobView(job));
      }
      throw new HttpError(404, 'NOT_FOUND', 'No such route.');
    } catch (err) {
      if (err instanceof HttpError) return sendError(res, err);
      log('http.error', { error: (err as Error).message });
      return sendError(res, new HttpError(500, 'INTERNAL', 'Internal error.'));
    }
  });

  let sweepTimer: NodeJS.Timeout | null = null;
  let pruneTimer: NodeJS.Timeout | null = null;

  return {
    config,
    codex,
    queue,
    server,
    async listen() {
      codex.start();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
      });
      pruneTimer = setInterval(() => queue.prune(), 60_000);
      pruneTimer.unref();
      if (storage.sweep) {
        const sweep = () => storage.sweep!(config.sweepMaxAgeMs).then(
          (n) => { if (n) log('r2.swept', { deleted: n }); },
          (err: Error) => log('r2.sweep_failed', { error: err.message }),
        );
        sweepTimer = setInterval(sweep, 60 * 60 * 1000);
        sweepTimer.unref();
      }
      const port = (server.address() as AddressInfo).port;
      log('http.listening', { host: config.host, port });
      return port;
    },
    async close() {
      closing = true;
      if (sweepTimer) clearInterval(sweepTimer);
      if (pruneTimer) clearInterval(pruneTimer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await codex.close();
    },
  };
}
