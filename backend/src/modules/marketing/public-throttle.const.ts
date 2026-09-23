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

/**
 * The per-channel inbound-mail callback, in a bucket of its own.
 *
 * It is a MACHINE callback, not a form submit, so the 20/min public-write bucket
 * is the wrong shape twice over: a relay delivers a busy mailbox's mail from one
 * egress IP, so a single tenant's morning post would exhaust it, and the
 * `blockDuration` those routes carry would then blackhole the next full minute
 * of mail. A 429 here is a lost customer reply — the same reasoning that gave
 * one-click unsubscribe its own bucket, for the same reason.
 *
 * It is still per-route rather than exempt: `@Throttle` overrides the single
 * global throttler, so dropping the decorator would leave an unauthenticated,
 * DB-writing, outbox-emitting route with no limit at all. The token in the URL
 * is the real gate; this is the bound on what an unauthenticated flood can cost.
 */
export const EMAIL_INBOUND_THROTTLE = {
  default: { limit: 600, ttl: 60_000 },
};

/**
 * Public tracking GETs — the trigger-link redirect, and the campaign open/click
 * redirects that share its shape.
 *
 * They write (a click row, a counter, a workflow event), so they need a bound.
 * But they are the only public route whose failure mode is a RECIPIENT being
 * sent nowhere: a 429 is a click that vanished, and the person who clicked has
 * no way to know or retry meaningfully. So this bucket is deliberately LOOSER
 * than the global 300/min default rather than tighter, for two reasons the
 * 20/min form bucket gets wrong:
 *
 * - a whole office sits behind one NAT gateway, and a campaign lands on all of
 *   them within the same minute;
 * - a mail-security gateway detonates every link in every mail from a handful
 *   of shared egress addresses, so the bursts that look worst are exactly the
 *   ones a real tenant causes.
 *
 * `blockDuration` is omitted on purpose, like one-click unsubscribe: the 60 s
 * blackout its siblings carry is what turns a single burst into a whole minute
 * of lost clicks. The point of the limit is to bound what an unauthenticated
 * flood can cost, not to punish a busy minute.
 */
export const TRACKING_GET_THROTTLE = {
  default: { limit: 600, ttl: 60_000 },
};
