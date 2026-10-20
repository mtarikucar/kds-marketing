import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from './errors.js';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

const refError = (i: number, why: string) =>
  new HttpError(400, 'REFERENCE_FETCH_FAILED', `referenceImages[${i}]: ${why}`, { details: [{ field: `referenceImages[${i}]`, message: why }] });

/**
 * Downloads reference images into the job directory as ref-N.<ext>. The hosts were already
 * checked against the allow-list; redirects are refused so they cannot lead elsewhere.
 */
export async function downloadReferences(
  urls: string[],
  dir: string,
  o: { fetch: typeof fetch; maxBytes: number; timeoutMs?: number },
): Promise<string[]> {
  const paths: string[] = [];
  for (const [i, url] of urls.entries()) {
    let res: Response;
    try {
      res = await o.fetch(url, { redirect: 'error', signal: AbortSignal.timeout(o.timeoutMs ?? 20_000) });
    } catch (err) {
      throw refError(i, `download failed (${(err as Error).message})`);
    }
    if (!res.ok) throw refError(i, `HTTP ${res.status}`);
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const ext = EXT[type];
    if (!ext) throw refError(i, `unsupported type ${type || 'unknown'} (png, jpeg, webp)`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > o.maxBytes) throw refError(i, `larger than ${o.maxBytes} bytes`);
    const chunks: Buffer[] = [];
    let size = 0;
    if (res.body) {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > o.maxBytes) throw refError(i, `larger than ${o.maxBytes} bytes`);
        chunks.push(Buffer.from(chunk));
      }
    }
    if (size === 0) throw refError(i, 'empty body');
    const path = join(dir, `ref-${i + 1}.${ext}`);
    await writeFile(path, Buffer.concat(chunks));
    paths.push(path);
  }
  return paths;
}
