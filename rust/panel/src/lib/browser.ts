/** A tab opened ahead of the address it is sent to (see `browser.openPending`). */
export interface PendingTab {
  /** Sends the tab to `url`. */
  go(url: string): void;
  /** Closes it: there is nothing to show. */
  close(): void;
}

/**
 * Leaving the panel for another site: a provider's sign-in page, or a file in a tab of its own.
 * One object, so tests replace `assign` and `openPending` (jsdom cannot follow a navigation to
 * another origin, nor open a tab).
 */
export const browser = {
  /** A full navigation to `url`, out of the panel. */
  assign(url: string): void {
    window.location.assign(url);
  },
  /**
   * A new tab opened now, while the click still counts as the person's, to be sent on once its
   * address is read (a file's address, signed on the click), or `null` when the browser blocked
   * it. The tab gets no hold on the panel: its `opener` is cleared before it goes anywhere.
   */
  openPending(): PendingTab | null {
    const tab = window.open('', '_blank');
    if (!tab) return null;
    tab.opener = null;
    return {
      go(url) {
        tab.location.href = url;
      },
      close() {
        tab.close();
      },
    };
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

/** The host names of this computer. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * `url` when the panel may open it in a tab: an absolute `https` address, or plain `http` to this
 * computer (a `jeeta serve` run locally signs its files so); else `null`.
 */
export function fileUrl(url: string): string | null {
  try {
    const address = new URL(url);
    if (address.protocol === 'https:') return url;
    return address.protocol === 'http:' && LOOPBACK.has(address.hostname) ? url : null;
  } catch {
    return null;
  }
}
