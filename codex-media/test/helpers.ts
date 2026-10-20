import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createApp, type App } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config.ts';
import type { Storage } from '../src/storage.ts';

export const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
export const PUBLIC_BASE = 'https://media.test';
const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_SERVER = join(here, 'fake-app-server.mjs');

export class MemoryStorage implements Storage {
  readonly objects = new Map<string, { body: Buffer; contentType: string; cacheControl?: string }>();
  failures = 0;
  attempts = 0;
  async upload(key: string, body: Buffer, contentType: string): Promise<string> {
    this.attempts++;
    if (this.failures > 0) { this.failures--; throw new Error('r2 down'); }
    this.objects.set(key, { body, contentType });
    return `${PUBLIC_BASE}/${key}`;
  }
}

export function png(width: number, height: number, color = { r: 200, g: 30, b: 30 }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

export interface TestApp {
  app: App;
  base: string;
  tmp: string;
  storage: MemoryStorage;
  /** Every JSON-RPC message the service sent to the fake app-server. */
  sent(): Array<Record<string, any>>;
  close(): Promise<void>;
}

export async function startTestApp(o: {
  fakeEnv?: Record<string, string>;
  config?: Partial<AppConfig>;
  fetch?: typeof fetch;
  storage?: MemoryStorage;
  image?: Buffer;
  waitReady?: boolean;
} = {}): Promise<TestApp> {
  const tmp = mkdtempSync(join(tmpdir(), 'codex-media-test-'));
  const fakeLog = join(tmp, 'fake.jsonl');
  const imagePath = join(tmp, 'fake.png');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(imagePath, o.image ?? await png(941, 1672));
  const storage = o.storage ?? new MemoryStorage();
  const config: AppConfig = {
    ...loadConfig({
      CODEX_MEDIA_SECRET: SECRET,
      R2_PUBLIC_BASE_URL: PUBLIC_BASE,
      CODEX_MEDIA_WORK_DIR: join(tmp, 'work'),
    }),
    port: 0,
    host: '127.0.0.1',
    codexCommand: [process.execPath, FAKE_SERVER],
    codexShell: false,
    codexEnv: { ...process.env, FAKE_LOG: fakeLog, FAKE_IMAGE: imagePath, ...o.fakeEnv },
    restartMinMs: 30,
    restartMaxMs: 200,
    log: () => {},
    ...o.config,
  };
  const app = createApp(config, { storage, fetch: o.fetch });
  const port = await app.listen();
  if (o.waitReady !== false) await waitFor(() => app.codex.state !== 'starting', 5000);
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    tmp,
    storage,
    sent: () => existsSync(fakeLog) ? readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [],
    close: async () => { await app.close(); rmSync(tmp, { recursive: true, force: true }); },
  };
}

export async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > until) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

export async function api(base: string, path: string, init: { method?: string; body?: unknown; secret?: string | null; raw?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.secret !== null) headers.authorization = `Bearer ${init.secret ?? SECRET}`;
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? (init.body !== undefined || init.raw !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.raw ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

export async function untilDone(base: string, jobId: string, timeoutMs = 8000) {
  let last: any;
  await waitFor(async () => {
    last = (await api(base, `/jobs/${jobId}`)).body;
    return last?.status === 'COMPLETED' || last?.status === 'FAILED';
  }, timeoutMs);
  return last;
}
