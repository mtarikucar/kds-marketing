/**
 * Copy text to the clipboard, returning whether it ACTUALLY succeeded.
 *
 * The async Clipboard API only works in a secure context (HTTPS) with
 * permission: it is `undefined` on http://, and it REJECTS when permission is
 * denied or the document isn't focused. Callers that fire a synchronous
 * "Copied!" toast right after calling it therefore lie when it fails — which is
 * silent data loss for a show-once secret (API key / webhook signing secret):
 * the user trusts the toast, closes the dialog, and the secret is gone.
 *
 * Await this and report the real outcome. Falls back to the legacy
 * execCommand('copy') path when the async API is unavailable or fails.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied / not focused / not allowed — fall through to legacy.
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
