/**
 * Tight per-route throttle for UNAUTHENTICATED public WRITE endpoints
 * (form submit, booking reserve, survey/experiment, review, web-chat session +
 * messages). These create Leads/Bookings/Conversations and fan out workflow
 * events, yet only fall to the loose 300/min global IP bucket — a real visitor
 * never exceeds this, but it caps the spam / lead-pollution / DB-growth abuse
 * that the global limit allows. Keyed by IP via the global throttler guard.
 */
export const PUBLIC_WRITE_THROTTLE = {
  default: { limit: 20, ttl: 60_000, blockDuration: 60_000 },
};

/**
 * The unsubscribe POST — and only that route — sits in its own, looser bucket.
 *
 * It is still a public write, so it keeps a per-route limit rather than being
 * exempted: `@Throttle` overrides the single global throttler, so dropping the
 * decorator would leave an unauthenticated, DB-writing, outbox-emitting route
 * with NO limit at all. But it cannot share the 20/min form bucket either:
 * RFC 8058 One-Click POSTs arrive from a handful of shared mailbox-provider
 * egress IPs (Google, Yahoo, Microsoft), so one campaign's opt-outs collapse
 * onto a couple of source addresses and overflow gets a 429. A dropped
 * unsubscribe is a consent failure, not spam prevented.
 *
 * `blockDuration` is deliberately omitted: the siblings' 60 s blackout is the
 * part that turns a single burst into a whole minute of lost opt-outs. The
 * handler itself is idempotent, so a retry costs a row read and nothing else.
 */
export const ONE_CLICK_UNSUBSCRIBE_THROTTLE = {
  default: { limit: 240, ttl: 60_000 },
};
