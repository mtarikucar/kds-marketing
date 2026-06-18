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
