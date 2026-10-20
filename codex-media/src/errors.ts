export type JobErrorCode =
  | 'CONTENT_BLOCKED'
  | 'POLICY_VIOLATION'
  | 'NO_IMAGE'
  | 'TIMEOUT'
  | 'CODEX_PROCESS_EXITED'
  | 'CODEX_QUOTA_EXHAUSTED'
  | 'CODEX_AUTH_REQUIRED'
  | 'CODEX_UNAVAILABLE'
  | 'CODEX_ERROR'
  | 'UPLOAD_FAILED'
  | 'INTERNAL';

/** A job ended in FAILED with a contract error code (§1.3). */
export class JobError extends Error {
  constructor(readonly code: JobErrorCode, message: string, readonly resetsAt?: string) {
    super(message);
  }
}

/** A request-level failure with an HTTP status and contract error code. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}
