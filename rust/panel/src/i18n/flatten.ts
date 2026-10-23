/**
 * A nested catalog as `a.b.c` → text. Every leaf is kept: a number becomes its text and `null`
 * (or any other non-string) the empty string, so the parity test sees and rejects it.
 */
export function flatten(obj: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (obj !== null && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      flatten(value, prefix ? `${prefix}.${key}` : key, out);
    }
  } else if (typeof obj === 'string') {
    out[prefix] = obj;
  } else if (typeof obj === 'number' || typeof obj === 'boolean') {
    out[prefix] = String(obj);
  } else {
    out[prefix] = '';
  }
  return out;
}
