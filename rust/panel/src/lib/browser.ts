/**
 * Leaving the panel for another site: a provider's sign-in page. One object, so tests replace
 * `assign` (jsdom cannot follow a navigation to another origin).
 */
export const browser = {
  /** A full navigation to `url`, out of the panel. */
  assign(url: string): void {
    window.location.assign(url);
  },
};

/**
 * `url` when it is an absolute `https` address (a provider's sign-in page), else `null`: the panel
 * never sends the browser to a script, a plain-http or a relative address it was handed.
 */
export function providerUrl(url: string): string | null {
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
