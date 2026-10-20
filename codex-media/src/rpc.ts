import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type Obj = Record<string, unknown>;
export const obj = (v: unknown): Obj => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export interface RpcOptions {
  command: string[];
  shell: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Notifications (no id). */
  onNotification: (method: string, params: Obj) => void;
  /** Requests from the server (have id + method); the return value is sent back as `result`. */
  onRequest: (method: string, params: Obj) => Obj | null;
  onExit: (code: number | null, stderrTail: string) => void;
}

/**
 * Newline-delimited JSON-RPC over the app-server's stdio. Pattern from the office's
 * control-center/apps/office-server/src/codex/rpc.ts: per-request timeout, every pending
 * request is rejected when the process goes away. The app-server never listens on a port.
 */
export class CodexRpc {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, { resolve: (v: Obj) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  #id = 0;
  #stderr = '';
  #exited = false;
  readonly closed: Promise<void>;

  constructor(o: RpcOptions) {
    const [command, ...prefix] = o.command;
    if (!command) throw new Error('codex command is empty');
    const args = [...prefix, 'app-server', '--listen', 'stdio://'];
    // With a shell (Windows `codex.cmd`) pass one command line: the arguments are fixed, nothing user-supplied.
    this.#child = spawn(o.shell ? [command, ...args].join(' ') : command, o.shell ? [] : args, {
      cwd: o.cwd,
      env: o.env,
      shell: o.shell,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    this.closed = new Promise((resolve) => {
      const finish = (code: number | null) => {
        if (this.#exited) return;
        this.#exited = true;
        for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(new Error('codex app-server exited')); }
        this.#pending.clear();
        o.onExit(code, this.#stderr);
        resolve();
      };
      this.#child.on('close', (code) => finish(code));
      this.#child.on('error', (err) => {
        this.#stderr = `${this.#stderr}\n${err.message}`.slice(-4000);
        if (this.#child.pid === undefined) finish(null);
      });
    });
    this.#child.stderr.on('data', (d: Buffer) => { this.#stderr = (this.#stderr + d.toString('utf8')).slice(-4000); });
    this.#child.stdin.on('error', () => {});
    createInterface({ input: this.#child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      let m: Obj;
      try { m = obj(JSON.parse(line)); } catch { return; }
      const method = str(m.method);
      if (method && m.id !== undefined) {
        let result: Obj | null;
        try { result = o.onRequest(method, obj(m.params)); } catch { result = null; }
        this.#send(result ? { id: m.id, result } : { id: m.id, error: { code: -32601, message: 'codex-media does not support this request' } });
        return;
      }
      if (method) { o.onNotification(method, obj(m.params)); return; }
      const p = typeof m.id === 'number' ? this.#pending.get(m.id) : undefined;
      if (!p) return;
      this.#pending.delete(m.id as number);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(str(obj(m.error).message) || 'codex request failed'));
      else p.resolve(obj(m.result));
    });
  }

  get exited(): boolean { return this.#exited; }
  get stderrTail(): string { return this.#stderr; }

  notify(method: string, params: Obj = {}): void { this.#send({ method, params }); }

  request(method: string, params: Obj = {}, timeoutMs = 60_000): Promise<Obj> {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`codex ${method} timed out`)); }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#send({ id, method, params }); } catch (err) { this.#pending.delete(id); clearTimeout(timer); reject(err as Error); }
    });
  }

  async close(graceMs = 2000): Promise<void> {
    if (this.#exited) return;
    this.#child.stdin.end();
    const term = setTimeout(() => this.#kill('SIGTERM'), graceMs);
    const kill = setTimeout(() => this.#kill('SIGKILL'), graceMs * 2);
    try { await this.closed; } finally { clearTimeout(term); clearTimeout(kill); }
  }

  #send(message: unknown): void {
    if (this.#exited || !this.#child.stdin.writable) throw new Error('codex app-server is not running');
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #kill(signal: NodeJS.Signals): void {
    const pid = this.#child.pid;
    if (pid === undefined) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { this.#child.kill(signal); });
      return;
    }
    try { process.kill(-pid, signal); } catch { this.#child.kill(signal); }
  }
}
