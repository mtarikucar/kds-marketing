import { mkdirSync } from 'node:fs';
import { CodexRpc, obj, str, num, type Obj } from './rpc.js';
import { JobError } from './errors.js';

export type CodexState = 'starting' | 'ready' | 'auth_required' | 'down';

export type UserInput = { type: 'text'; text: string; text_elements: [] } | { type: 'localImage'; path: string };

export interface GeneratedImage {
  base64: string;
  savedPath: string | null;
  revisedPrompt: string | null;
}

export interface CodexClientOptions {
  command: string[];
  shell: boolean;
  env: NodeJS.ProcessEnv;
  /** Working directory of the app-server process itself (each thread gets its own cwd). */
  cwd: string;
  model?: string;
  rpcTimeoutMs: number;
  restartMinMs: number;
  restartMaxMs: number;
  quotaCeilingPercent: number;
  log: (event: string, fields?: Obj) => void;
}

export const DEVELOPER_INSTRUCTIONS =
  'You are an image generation backend. Call the image generation tool exactly once. Never run commands, read files or browse. Reply only with DONE.';

/** §1.6: the prompt comes from customers/AI, so the agent gets no tools besides image generation. */
const LOCKED_FEATURES: Obj = {
  'features.image_generation': true,
  'features.apps': false,
  'features.multi_agent': false,
  'features.plugins': false,
  'features.memories': false,
  web_search: 'disabled',
};

/** Items that mean the agent tried to act instead of only drawing. */
const FORBIDDEN_ITEMS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'dynamicToolCall', 'collabAgentToolCall']);

const WEEK_MINS = 7 * 24 * 60;

/** Every request the app-server can make of a client is answered with "no" (§1.6). */
export function declineServerRequest(method: string): Obj | null {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' };
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return { decision: 'denied' };
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' };
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null };
    case 'item/tool/requestUserInput':
      return { answers: {} };
    default:
      return null;
  }
}

interface TurnWatch {
  jobId: string;
  threadId: string;
  turnId: string | null;
  image: GeneratedImage | null;
  blocked: string | null;
  error: JobError | null;
  interruptWhenStarted: boolean;
  settled: boolean;
  resolve: (img: GeneratedImage) => void;
  reject: (err: JobError) => void;
  timer: NodeJS.Timeout | null;
}

/**
 * One long-lived `codex app-server` process; every job is its own ephemeral thread.
 * The process is restarted with exponential backoff when it dies; jobs running at that
 * moment fail with CODEX_PROCESS_EXITED.
 */
export class CodexClient {
  state: CodexState = 'starting';
  weeklyUsedPercent: number | null = null;
  #weeklyResetsAt: number | null = null;
  #limitReached = false;
  #rpc: CodexRpc | null = null;
  #overrides: Obj = { ...LOCKED_FEATURES };
  readonly #turns = new Map<string, TurnWatch>();
  #restartAttempts = 0;
  #restartTimer: NodeJS.Timeout | null = null;
  #authTimer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(private readonly o: CodexClientOptions) {}

  get running(): number { return this.#turns.size; }

  start(): void {
    if (this.#authTimer === null) {
      this.#authTimer = setInterval(() => { if (this.state === 'auth_required') void this.refreshAccount(); }, 30_000);
      this.#authTimer.unref();
    }
    void this.#spawn();
  }

  /** Re-reads the ChatGPT login; used when it was missing (someone may have run `codex login` since). */
  async refreshAccount(): Promise<CodexState> {
    const rpc = this.#rpc;
    if (!rpc || rpc.exited || this.state === 'starting' || this.state === 'down') return this.state;
    try {
      const account = await rpc.request('account/read', { refreshToken: false }, this.o.rpcTimeoutMs);
      if (rpc === this.#rpc && !rpc.exited) this.state = account.requiresOpenaiAuth === true && !account.account ? 'auth_required' : 'ready';
    } catch { /* keep the previous state; the exit handler deals with a dead process */ }
    return this.state;
  }

  /** Non-null when new work must be refused because of the weekly quota (§7 ceiling or a hit limit). */
  quotaBlock(now = Date.now()): { resetsAt: string | null } | null {
    if (this.#limitReached && this.#weeklyResetsAt !== null && now >= this.#weeklyResetsAt) this.#limitReached = false;
    const overCeiling = this.weeklyUsedPercent !== null && this.weeklyUsedPercent >= this.o.quotaCeilingPercent;
    if (!this.#limitReached && !overCeiling) return null;
    return { resetsAt: this.#weeklyResetsAt !== null ? new Date(this.#weeklyResetsAt).toISOString() : null };
  }

  async generate(job: { jobId: string; cwd: string; input: UserInput[]; timeoutMs: number }): Promise<GeneratedImage> {
    if (this.state === 'auth_required') throw new JobError('CODEX_AUTH_REQUIRED', 'ChatGPT login is missing; run `codex login --device-auth`.');
    const rpc = this.#rpc;
    if (this.state !== 'ready' || !rpc || rpc.exited) throw new JobError('CODEX_UNAVAILABLE', 'codex app-server is not running.');
    const quota = this.quotaBlock();
    if (quota) throw new JobError('CODEX_QUOTA_EXHAUSTED', 'Codex weekly quota is used up.', quota.resetsAt ?? undefined);

    const deadline = Date.now() + job.timeoutMs;
    let threadId: string;
    try {
      const started = await rpc.request('thread/start', {
        cwd: job.cwd,
        ephemeral: true,
        approvalPolicy: 'untrusted',
        sandbox: 'read-only',
        ...(this.o.model ? { model: this.o.model } : {}),
        config: this.#overrides,
        developerInstructions: DEVELOPER_INSTRUCTIONS,
      }, Math.min(this.o.rpcTimeoutMs, job.timeoutMs));
      threadId = str(obj(started.thread).id);
      if (!threadId) throw new Error('thread/start returned no thread id');
    } catch (err) {
      throw rpc.exited ? new JobError('CODEX_PROCESS_EXITED', 'codex app-server exited during the job.') : new JobError('CODEX_ERROR', (err as Error).message);
    }

    return new Promise<GeneratedImage>((resolve, reject) => {
      const w: TurnWatch = {
        jobId: job.jobId, threadId, turnId: null, image: null, blocked: null, error: null,
        interruptWhenStarted: false, settled: false, resolve, reject, timer: null,
      };
      this.#turns.set(threadId, w);
      w.timer = setTimeout(() => this.#fail(w, new JobError('TIMEOUT', `No image within ${job.timeoutMs} ms.`), true), Math.max(1, deadline - Date.now()));
      rpc.request('turn/start', { threadId, input: job.input }, this.o.rpcTimeoutMs).then((r) => {
        w.turnId = str(obj(r.turn).id) || null;
        if (w.interruptWhenStarted) this.#interrupt(w);
      }, (err: Error) => {
        this.#fail(w, rpc.exited ? new JobError('CODEX_PROCESS_EXITED', 'codex app-server exited during the job.') : new JobError('CODEX_ERROR', err.message));
      });
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    if (this.#authTimer) clearInterval(this.#authTimer);
    for (const w of this.#turns.values()) this.#fail(w, new JobError('CODEX_UNAVAILABLE', 'codex-media is shutting down.'));
    await this.#rpc?.close(500);
  }

  async #spawn(): Promise<void> {
    if (this.#closed) return;
    this.state = 'starting';
    mkdirSync(this.o.cwd, { recursive: true });
    let rpc: CodexRpc;
    try {
      rpc = new CodexRpc({
        command: this.o.command,
        shell: this.o.shell,
        cwd: this.o.cwd,
        env: this.o.env,
        onNotification: (method, params) => this.#onNotification(method, params),
        onRequest: (method, params) => {
          const reply = declineServerRequest(method);
          this.o.log('codex.request_declined', { method, threadId: str(params.threadId) || undefined });
          return reply;
        },
        onExit: (code, stderr) => this.#onExit(rpc, code, stderr),
      });
    } catch (err) {
      this.o.log('codex.spawn_failed', { error: (err as Error).message });
      this.state = 'down';
      this.#scheduleRestart();
      return;
    }
    this.#rpc = rpc;
    try {
      await rpc.request('initialize', { clientInfo: { name: 'codex_media', title: 'Jeeta codex-media', version: '0.1.0' } }, this.o.rpcTimeoutMs);
      rpc.notify('initialized');
      const config = obj((await rpc.request('config/read', { includeLayers: false }, this.o.rpcTimeoutMs)).config);
      const overrides: Obj = { ...LOCKED_FEATURES };
      for (const name of Object.keys(obj(config.mcp_servers))) overrides[`mcp_servers.${name}.enabled`] = false;
      for (const name of Object.keys(obj(config.plugins))) overrides[`plugins.${name}.enabled`] = false;
      this.#overrides = overrides;
      try {
        const limits = await rpc.request('account/rateLimits/read', {}, this.o.rpcTimeoutMs);
        this.#applyRateLimits(obj(obj(limits.rateLimitsByLimitId).codex ?? limits.rateLimits));
      } catch (err) {
        this.o.log('codex.rate_limits_unavailable', { error: (err as Error).message });
      }
      const account = await rpc.request('account/read', { refreshToken: false }, this.o.rpcTimeoutMs);
      if (rpc !== this.#rpc || rpc.exited) return;
      this.state = account.requiresOpenaiAuth === true && !account.account ? 'auth_required' : 'ready';
      this.#restartAttempts = 0;
      this.o.log('codex.started', { state: this.state, weeklyUsedPercent: this.weeklyUsedPercent ?? undefined });
    } catch (err) {
      this.o.log('codex.init_failed', { error: (err as Error).message });
      if (!rpc.exited) await rpc.close(500);
    }
  }

  #scheduleRestart(): void {
    if (this.#closed) return;
    const delay = Math.min(this.o.restartMaxMs, this.o.restartMinMs * 2 ** this.#restartAttempts);
    this.#restartAttempts++;
    this.#restartTimer = setTimeout(() => { this.#restartTimer = null; void this.#spawn(); }, delay);
    this.#restartTimer.unref();
  }

  #onExit(rpc: CodexRpc, code: number | null, stderr: string): void {
    if (rpc !== this.#rpc) return;
    this.state = 'down';
    this.o.log('codex.exited', { code, stderr: stderr.trim().slice(-300) || undefined });
    for (const w of [...this.#turns.values()]) this.#fail(w, new JobError('CODEX_PROCESS_EXITED', 'codex app-server exited during the job.'));
    this.#scheduleRestart();
  }

  #applyRateLimits(snapshot: Obj): void {
    const limitId = str(snapshot.limitId);
    if (limitId && limitId !== 'codex') return;
    const windows = [obj(snapshot.primary), obj(snapshot.secondary)].filter((w) => num(w.usedPercent) !== null);
    const weekly = windows.find((w) => num(w.windowDurationMins) === WEEK_MINS) ?? (snapshot.secondary ? obj(snapshot.secondary) : undefined);
    if (weekly && num(weekly.usedPercent) !== null) {
      this.weeklyUsedPercent = num(weekly.usedPercent);
      const resets = num(weekly.resetsAt);
      if (resets !== null) this.#weeklyResetsAt = resets * 1000;
      if (this.weeklyUsedPercent! < 100 && snapshot.rateLimitReachedType == null) this.#limitReached = false;
    }
    if (snapshot.rateLimitReachedType != null) this.#limitReached = true;
  }

  #onNotification(method: string, p: Obj): void {
    if (method === 'account/rateLimits/updated') { this.#applyRateLimits(obj(p.rateLimits)); return; }
    if (method === 'account/updated') { void this.refreshAccount(); return; }
    const w = this.#turns.get(str(p.threadId));
    if (!w || w.settled) return;
    const item = obj(p.item);
    const type = str(item.type);
    if (method === 'item/started' && FORBIDDEN_ITEMS.has(type)) {
      this.o.log('codex.policy_violation', { jobId: w.jobId, item: type });
      this.#fail(w, new JobError('POLICY_VIOLATION', `The agent started a ${type}; image jobs may not use tools.`), true);
      return;
    }
    if (method === 'item/completed' && type === 'imageGeneration' && !w.image && !w.blocked) {
      const failure = item.failure;
      if (failure || item.status !== 'completed') {
        const f = obj(failure);
        w.blocked = str(f.message) || str(f.type) || `image generation ${str(item.status) || 'failed'}`;
      } else {
        w.image = { base64: str(item.result), savedPath: str(item.savedPath) || null, revisedPrompt: str(item.revisedPrompt) || null };
      }
      return;
    }
    if (method === 'error' && p.willRetry !== true) {
      const e = obj(p.error);
      const info = e.codexErrorInfo;
      const message = str(e.message) || 'codex error';
      if (info === 'usageLimitExceeded' || /usage limit/i.test(message)) {
        this.#limitReached = true;
        w.error = new JobError('CODEX_QUOTA_EXHAUSTED', message, this.quotaBlock()?.resetsAt ?? undefined);
      } else if (info === 'unauthorized') {
        this.state = 'auth_required';
        w.error = new JobError('CODEX_AUTH_REQUIRED', message);
      } else {
        w.error = new JobError('CODEX_ERROR', message);
      }
      return;
    }
    if (method === 'turn/completed') {
      const turn = obj(p.turn);
      if (w.image) return this.#succeed(w, w.image);
      if (w.blocked) return this.#fail(w, new JobError('CONTENT_BLOCKED', `Codex refused the request: ${w.blocked}`));
      if (w.error) {
        if (w.error.code === 'CODEX_QUOTA_EXHAUSTED' && !w.error.resetsAt) {
          w.error = new JobError('CODEX_QUOTA_EXHAUSTED', w.error.message, this.quotaBlock()?.resetsAt ?? undefined);
        }
        return this.#fail(w, w.error);
      }
      if (turn.status === 'failed') return this.#fail(w, new JobError('CODEX_ERROR', str(obj(turn.error).message) || 'turn failed'));
      return this.#fail(w, new JobError('NO_IMAGE', 'The turn ended without an image.'));
    }
  }

  #succeed(w: TurnWatch, image: GeneratedImage): void {
    if (w.settled) return;
    w.settled = true;
    if (w.timer) clearTimeout(w.timer);
    this.#turns.delete(w.threadId);
    w.resolve(image);
  }

  #fail(w: TurnWatch, err: JobError, interrupt = false): void {
    if (w.settled) return;
    w.settled = true;
    if (w.timer) clearTimeout(w.timer);
    this.#turns.delete(w.threadId);
    if (interrupt) {
      if (w.turnId) this.#interrupt(w);
      else w.interruptWhenStarted = true;
    }
    w.reject(err);
  }

  #interrupt(w: TurnWatch): void {
    const rpc = this.#rpc;
    if (!rpc || rpc.exited || !w.turnId) return;
    rpc.request('turn/interrupt', { threadId: w.threadId, turnId: w.turnId }, this.o.rpcTimeoutMs).catch(() => {});
  }
}
