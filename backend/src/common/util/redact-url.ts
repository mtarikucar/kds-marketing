/**
 * Redact secret query-param VALUES from a request URL before it is logged or
 * reflected back to a caller. Some routes carry credentials in the query string
 * (e.g. the SSE stream guard accepts `?access_token=<JWT>` because EventSource
 * can't set an Authorization header), and the access log + the 5xx error body
 * both echo the raw URL — which would leak a live session token into logs and
 * error responses. This strips the value of any sensitive param to `***` while
 * preserving the path and benign params.
 *
 * Operates on a path+query string (Express `req.originalUrl`), not an absolute
 * URL, so it never throws on a relative target.
 */
const SENSITIVE_PARAM =
  /^(access_token|refresh_token|token|secret|password|passwd|api_?key|apikey|authorization|auth|sig|signature)$/i;

export function redactUrl(rawUrl: string): string {
  const qIdx = rawUrl.indexOf('?');
  if (qIdx === -1) return rawUrl;
  const path = rawUrl.slice(0, qIdx);
  const query = rawUrl.slice(qIdx + 1);
  const redacted = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const name = pair.slice(0, eq);
      let decoded = name;
      try {
        decoded = decodeURIComponent(name);
      } catch {
        /* keep the raw name for matching */
      }
      return SENSITIVE_PARAM.test(decoded) ? `${name}=***` : pair;
    })
    .join('&');
  return `${path}?${redacted}`;
}
