import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeFetch } from '../../../../common/util/safe-fetch';

/**
 * Measure a media file the customer supplied.
 *
 * Five models in the catalogue are priced on a property of the caller's OWN
 * file — its duration, or its pixel count — and were withheld from sale for
 * exactly one reason: nothing here could measure that file. A quantity the
 * CALLER states is not a measurement, it is a number the payer chooses; and
 * these endpoints report nothing back afterwards, so whatever is used at
 * reserve time is billed permanently, with no true-up to correct it.
 *
 * A hand-written container parser was tried and withdrawn for being unsound in
 * BOTH directions — it invented a duration for roughly one ordinary
 * non-faststart phone video in three, and a decoy `mvhd` box walked it into a
 * 600x under-charge. This is the replacement the withheld note asked for: a
 * real probe, reading the real container.
 *
 * ── WHY THE FILE IS DOWNLOADED FIRST ───────────────────────────────────────
 *
 * ffprobe has its own protocol handlers. Handing it a URL would let it fetch
 * that URL itself, straight past this codebase's SSRF guard — and ffmpeg's
 * protocol list includes far more than http: `concat:`, `file:`, `subfile:`,
 * and friends turn a probe into an arbitrary-read primitive. So the URL is
 * fetched by `safeFetch` (scheme allow-list, private-range DNS checks,
 * re-validated redirects) and ffprobe is shown a local path and told, in
 * `-protocol_whitelist`, that `file` is the only protocol it may use.
 *
 * Everything else here is a refusal: a byte cap so a hostile URL cannot fill
 * the disk, a process timeout so a crafted container cannot wedge the
 * container, and `execFile` rather than `exec` so no shell ever sees the path.
 *
 * ── AND WHY IT NEVER GUESSES ───────────────────────────────────────────────
 *
 * Every failure returns nulls with a reason. `meteredUnits` reads a null as
 * "refuse", which is the same answer these models gave while withheld. That is
 * deliberate: not selling a generation is recoverable, and billing someone for
 * a number nobody measured is not.
 */

/** Flat, like the other result types in this codebase: `strictNullChecks` is
 *  off, so a union would not narrow on `error`. */
export interface MediaMeasurement {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  /** Non-null means nothing above is usable. */
  error: string | null;
}

/** Large enough for any legitimate source a customer uploads to a marketing
 *  tool; small enough that a hostile URL cannot fill the container's disk. */
const MAX_BYTES = 512 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 20_000;

@Injectable()
export class MediaProbeService {
  private readonly logger = new Logger(MediaProbeService.name);

  async measure(url: string): Promise<MediaMeasurement> {
    const fail = (error: string): MediaMeasurement => ({
      durationSec: null, width: null, height: null, error,
    });
    if (!url) return fail('no source url');

    let path: string | null = null;
    try {
      path = await this.download(url);
      return await this.probe(path);
    } catch (e: any) {
      // Includes SsrfBlockedError, timeouts, and an oversize body. All of them
      // mean the same thing to the caller: this cannot be priced.
      return fail(String(e?.message ?? e).slice(0, 300));
    } finally {
      if (path) await fs.unlink(path).catch(() => undefined);
    }
  }

  /** Fetch through the SSRF guard, streaming to a temp file under a byte cap. */
  private async download(url: string): Promise<string> {
    const res = await safeFetch(url, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
    if (!res.ok) throw new Error(`source fetch failed: HTTP ${res.status}`);

    // Content-Length is a hint, not a promise — a lying header would simply be
    // caught by the running total below. Checking it first just avoids starting
    // a download we already know is too big.
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      throw new Error(`source is larger than the ${MAX_BYTES} byte probe limit`);
    }

    const path = join(tmpdir(), `media-probe-${randomUUID()}`);
    const handle = await fs.open(path, 'w');
    try {
      let total = 0;
      // Node's fetch body is an async-iterable ReadableStream; streaming it is
      // what keeps the byte cap meaningful (buffering first would already have
      // spent the memory the cap exists to protect).
      for await (const chunk of (res.body ?? []) as AsyncIterable<Uint8Array>) {
        total += chunk.length;
        if (total > MAX_BYTES) {
          throw new Error(`source is larger than the ${MAX_BYTES} byte probe limit`);
        }
        await handle.write(chunk);
      }
      if (total === 0) throw new Error('source is empty');
    } finally {
      await handle.close().catch(() => undefined);
    }
    return path;
  }

  /** Ask ffprobe, and believe only what it actually reports. */
  private probe(path: string): Promise<MediaMeasurement> {
    const args = [
      '-v', 'error',
      // ffprobe may open NOTHING but a local file. Without this it would still
      // honour `concat:` and friends embedded in a crafted container.
      '-protocol_whitelist', 'file',
      '-show_entries', 'format=duration:stream=width,height',
      '-of', 'json',
      '-i', path,
    ];
    return new Promise<MediaMeasurement>((resolve) => {
      execFile('ffprobe', args, { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err) {
          // ENOENT here means ffprobe is not installed in this image. That is
          // not an error to paper over: it degrades to the same refusal these
          // models had while withheld, and the message says which it was.
          const why = (err as any).code === 'ENOENT' ? 'ffprobe is not installed on this server' : String(err.message);
          resolve({ durationSec: null, width: null, height: null, error: why.slice(0, 300) });
          return;
        }
        resolve(parseProbeJson(stdout));
      });
    });
  }
}

/** Exported for the tests: the parsing is the part with the sharp edges. */
export function parseProbeJson(stdout: string): MediaMeasurement {
  let json: any;
  try {
    json = JSON.parse(stdout);
  } catch {
    return { durationSec: null, width: null, height: null, error: 'ffprobe returned no readable output' };
  }

  const raw = Number(json?.format?.duration);
  // A container with no duration (a still image, a stream) reports nothing or
  // "N/A". Zero is not a duration either — treating it as one would bill a
  // per-second model for nothing and, worse, look like a successful measurement.
  const durationSec = Number.isFinite(raw) && raw > 0 ? raw : null;

  // The FIRST stream carrying dimensions. A video file's streams include audio
  // (no width) and can include attached cover art, so picking `streams[0]`
  // blindly measures the wrong thing.
  const streams: any[] = Array.isArray(json?.streams) ? json.streams : [];
  const sized = streams.find((s) => Number(s?.width) > 0 && Number(s?.height) > 0);
  const width = sized ? Number(sized.width) : null;
  const height = sized ? Number(sized.height) : null;

  if (durationSec === null && width === null) {
    return { durationSec: null, width: null, height: null, error: 'ffprobe could not measure this file' };
  }
  return { durationSec, width, height, error: null };
}
