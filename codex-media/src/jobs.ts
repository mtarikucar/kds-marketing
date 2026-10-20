import { randomBytes } from 'node:crypto';
import { JobError, type JobErrorCode } from './errors.js';
import type { AspectRatio } from './config.js';

export type JobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface JobRequest {
  prompt: string;
  aspectRatio: AspectRatio;
  referenceImages: string[];
  workspaceId?: string;
  clientRef?: string;
}

export interface JobOutput {
  url: string;
  mime: string;
  width: number;
  height: number;
  revisedPrompt: string | null;
}

export interface Job {
  id: string;
  status: JobStatus;
  request: JobRequest;
  /** Local reference files, downloaded before the job was queued. */
  refPaths: string[];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  output?: JobOutput;
  error?: { code: JobErrorCode; message: string; resetsAt?: string };
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** `cm_` + 10 time chars + 8 random chars (Crockford base32, sortable like a ULID). */
export function newJobId(now = Date.now()): string {
  let t = now, time = '';
  for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); }
  const rnd = [...randomBytes(8)].map((b) => CROCKFORD[b % 32]).join('');
  return `cm_${time}${rnd}`;
}

export class QueueFullError extends Error {}

export interface JobQueueOptions {
  concurrency: number;
  maxQueue: number;
  ttlMs: number;
  idempotencyMs: number;
  run: (job: Job) => Promise<JobOutput>;
  onSettled?: (job: Job) => void;
  now?: () => number;
}

/** In-memory FIFO with a concurrency cap. Finished jobs are forgotten after ttlMs (§1.2). */
export class JobQueue {
  readonly #jobs = new Map<string, Job>();
  readonly #waiting: Job[] = [];
  readonly #byClientRef = new Map<string, { jobId: string; at: number }>();
  #running = 0;
  readonly #now: () => number;

  constructor(private readonly o: JobQueueOptions) {
    this.#now = o.now ?? Date.now;
  }

  get queued(): number { return this.#waiting.length; }
  get running(): number { return this.#running; }

  /** The live job for this clientRef if one was submitted within the idempotency window. */
  findByClientRef(clientRef: string | undefined): Job | undefined {
    if (!clientRef) return undefined;
    this.prune();
    const hit = this.#byClientRef.get(clientRef);
    return hit ? this.#jobs.get(hit.jobId) : undefined;
  }

  hasRoom(): boolean { return this.#waiting.length < this.o.maxQueue || this.#running < this.o.concurrency; }

  /** Queues a job; the caller has already checked idempotency and room. */
  submit(id: string, request: JobRequest, refPaths: string[]): { job: Job; position: number } {
    this.prune();
    if (!this.hasRoom()) throw new QueueFullError('queue is full');
    const job: Job = { id, status: 'QUEUED', request, refPaths, createdAt: this.#now() };
    this.#jobs.set(id, job);
    if (request.clientRef) this.#byClientRef.set(request.clientRef, { jobId: id, at: job.createdAt });
    this.#waiting.push(job);
    const position = this.#waiting.length;
    this.#pump();
    return { job, position };
  }

  get(id: string): Job | undefined {
    this.prune();
    return this.#jobs.get(id);
  }

  prune(): void {
    const now = this.#now();
    for (const [id, job] of this.#jobs) {
      if (job.finishedAt !== undefined && now - job.finishedAt >= this.o.ttlMs) this.#jobs.delete(id);
    }
    for (const [ref, hit] of this.#byClientRef) {
      if (now - hit.at >= this.o.idempotencyMs || !this.#jobs.has(hit.jobId)) this.#byClientRef.delete(ref);
    }
  }

  #pump(): void {
    while (this.#running < this.o.concurrency && this.#waiting.length) {
      const job = this.#waiting.shift()!;
      this.#running++;
      job.status = 'RUNNING';
      job.startedAt = this.#now();
      this.o.run(job).then((output) => {
        job.status = 'COMPLETED';
        job.output = output;
      }, (err: unknown) => {
        job.status = 'FAILED';
        job.error = err instanceof JobError
          ? { code: err.code, message: err.message, ...(err.resetsAt ? { resetsAt: err.resetsAt } : {}) }
          : { code: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
      }).finally(() => {
        job.finishedAt = this.#now();
        this.#running--;
        this.o.onSettled?.(job);
        this.#pump();
      });
    }
  }
}
