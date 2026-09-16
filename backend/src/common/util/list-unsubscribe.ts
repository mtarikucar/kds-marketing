/**
 * RFC 8058 one-click unsubscribe headers.
 *
 * The endpoint side has existed for a long time: `POST /api/public/u/:token` is
 * throttled and documented as serving One-Click, and the GET is a confirm page
 * precisely so a mail-security scanner cannot unsubscribe someone by prefetching
 * links. What never existed was this pair of HEADERS — the thing that makes a
 * client render its own Unsubscribe button — so Gmail and Yahoo, who have
 * required them from bulk senders since February 2024, were never told that
 * campaign mail was bulk at all.
 *
 * One pure function owns the wire format because the same pair has to come out
 * of two unrelated transports — the workspace's own SMTP adapter and the
 * platform mailer — and two hand-written encodings of one header is exactly how
 * they drift apart.
 *
 * Returning `{}` rather than throwing is the load-bearing part: the caller
 * spreads the result, so "no URL" silently and correctly means "not bulk mail".
 * Inbox replies and transactional notices pass nothing and can never acquire a
 * header claiming they are a mailing list.
 */
export function listUnsubscribeHeaders(url?: string | null): Record<string, string> {
  const href = (url ?? '').trim();
  // Only an absolute http(s) URI: a client cannot act on a relative path, and a
  // non-http scheme in a header we generate is not something to pass along.
  if (!/^https?:\/\//i.test(href)) return {};
  return {
    // The field is a list of <URI> forms — a bare URL is ignored by strict parsers.
    'List-Unsubscribe': `<${href}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
