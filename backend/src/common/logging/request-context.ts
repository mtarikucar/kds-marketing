import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-request context carried implicitly through the async call tree
 * (Observability / Auditability).
 *
 * The correlation id is established once by `requestIdMiddleware` and then read
 * — without being threaded through every function signature — by:
 *   - {@link JsonLogger}, so every log line a service emits mid-request carries
 *     the same `requestId` as the access log and any 5xx error log; and
 *   - the audit interceptor, so an audit row records the request that caused it.
 *
 * `AsyncLocalStorage` propagates the store across `await`/callbacks, so a log
 * emitted deep inside a Prisma callback still sees the id with zero plumbing.
 */
export interface RequestContextStore {
  requestId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContextStore>();

/** The correlation id for the in-flight request, or undefined outside one. */
export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

/** Run `fn` with a fresh request-scoped store (used by the correlation middleware). */
export function runWithRequestContext<T>(
  store: RequestContextStore,
  fn: () => T,
): T {
  return requestContext.run(store, fn);
}
