import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

export const ASPECT_RATIOS = ['1:1', '4:5', '3:4', '4:3', '9:16', '16:9'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string;
}

export interface AppConfig {
  secret: string;
  host: string;
  port: number;
  concurrency: number;
  maxQueue: number;
  jobTimeoutMs: number;
  rpcTimeoutMs: number;
  /** Hosts references may be fetched from: the R2 public host plus CODEX_MEDIA_REF_HOSTS. */
  refHosts: string[];
  maxRefBytes: number;
  model?: string;
  /** argv of the app-server binary, without `app-server --listen stdio://`. */
  codexCommand: string[];
  /** Spawn through a shell (needed for `codex.cmd` on Windows). */
  codexShell: boolean;
  codexEnv: NodeJS.ProcessEnv;
  codexHome: string;
  workRoot: string;
  quotaCeilingPercent: number;
  jobTtlMs: number;
  idempotencyMs: number;
  restartMinMs: number;
  restartMaxMs: number;
  uploadRetryDelayMs: number;
  r2: R2Config | null;
  publicBaseUrl: string;
  /** CODEX_MEDIA_R2_DRYRUN=1: write images to this directory instead of R2. */
  dryRunDir: string | null;
  sweepMaxAgeMs: number;
  log: (line: string) => void;
}

const int = (v: string | undefined, d: number): number => {
  if (v === undefined || v.trim() === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Geçersiz sayı: ${v}`);
  return Math.floor(n);
};

const hostOf = (url: string): string | null => {
  try { return new URL(url).host; } catch { return null; }
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const secret = env.CODEX_MEDIA_SECRET ?? '';
  if (!secret) throw new Error('CODEX_MEDIA_SECRET zorunlu');
  const host = env.CODEX_MEDIA_HOST || '127.0.0.1';
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (Buffer.byteLength(secret) < 32 && !loopback) {
    throw new Error('CODEX_MEDIA_SECRET en az 32 bayt olmalı (yalnız 127.0.0.1 dinlerken kısa sır kabul edilir)');
  }
  const publicBaseUrl = (env.R2_PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  const extraHosts = (env.CODEX_MEDIA_REF_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const publicHost = hostOf(publicBaseUrl);
  const r2 = env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET && publicBaseUrl
    ? { accountId: env.R2_ACCOUNT_ID, accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, bucket: env.R2_BUCKET, publicBaseUrl }
    : null;
  const dryRun = env.CODEX_MEDIA_R2_DRYRUN === '1';
  const codexHome = env.CODEX_HOME || join(homedir(), '.codex');
  return {
    secret,
    host,
    port: int(env.CODEX_MEDIA_PORT, 7311),
    concurrency: Math.max(1, int(env.CODEX_MEDIA_CONCURRENCY, 2)),
    maxQueue: int(env.CODEX_MEDIA_MAX_QUEUE, 20),
    jobTimeoutMs: int(env.CODEX_MEDIA_JOB_TIMEOUT_MS, 180_000),
    rpcTimeoutMs: 60_000,
    refHosts: [...new Set([...(publicHost ? [publicHost.toLowerCase()] : []), ...extraHosts])],
    maxRefBytes: 20 * 1024 * 1024,
    model: env.CODEX_MEDIA_MODEL || undefined,
    codexCommand: [env.CODEX_MEDIA_CODEX_BIN || 'codex'],
    codexShell: process.platform === 'win32',
    codexEnv: { ...env, CODEX_HOME: codexHome },
    codexHome,
    workRoot: env.CODEX_MEDIA_WORK_DIR || join(tmpdir(), 'codex-media-work'),
    quotaCeilingPercent: int(env.CODEX_MEDIA_QUOTA_CEILING, 60),
    jobTtlMs: 60 * 60 * 1000,
    idempotencyMs: 10 * 60 * 1000,
    restartMinMs: 1000,
    restartMaxMs: 60_000,
    uploadRetryDelayMs: 500,
    r2: dryRun ? null : r2,
    publicBaseUrl,
    dryRunDir: dryRun ? (env.CODEX_MEDIA_DRYRUN_DIR || join(process.cwd(), 'out')) : null,
    sweepMaxAgeMs: 24 * 60 * 60 * 1000,
    log: (line) => process.stdout.write(`${line}\n`),
  };
}
