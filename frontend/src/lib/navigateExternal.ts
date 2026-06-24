/**
 * Navigate the browser to a server-provided external URL (OAuth authorize URLs,
 * PSP checkout URLs, review-platform links). These come from our own backend, so
 * there's no attacker injection path today — this is defence in depth: it refuses
 * anything that isn't an http(s) URL, so a `javascript:`/`data:` value can never
 * be assigned to location.href even if a response is ever tampered with.
 *
 * Returns false (and does nothing) when the URL is not a safe http(s) target.
 */
export function navigateExternal(url: string | null | undefined): boolean {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  window.location.assign(url);
  return true;
}
