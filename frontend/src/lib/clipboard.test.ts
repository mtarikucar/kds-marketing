import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyToClipboard } from './clipboard';

describe('copyToClipboard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // jsdom doesn't implement execCommand; tests assign it, so remove it after.
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });

  it('returns true when the async clipboard API resolves', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await copyToClipboard('secret')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('secret');
  });

  // The bug this guards: a rejected write must NOT report success (a "Copied!"
  // toast on a show-once secret that wasn't copied loses the secret).
  it('returns false when the write rejects and the fallback also fails', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn().mockReturnValue(false);
    expect(await copyToClipboard('secret')).toBe(false);
  });

  it('falls back to execCommand when the async clipboard API is unavailable', async () => {
    vi.stubGlobal('navigator', {}); // no clipboard (e.g. http:// context)
    const exec = vi.fn().mockReturnValue(true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    expect(await copyToClipboard('x')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
  });
});
