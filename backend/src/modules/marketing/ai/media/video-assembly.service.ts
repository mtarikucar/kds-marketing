import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeFetch } from '../../../../common/util/safe-fetch';
import { MediaProbeService } from './media-probe.service';

/**
 * Turn the clips a concept bought into the video it was supposed to be.
 *
 * A five-beat concept buys five generations, and until now that is where the
 * pipeline stopped: five separate files, one per beat, handed to a publisher
 * that can send at most a couple of them. The rest were paid for and thrown
 * away, and the thing the reviewer approved — a hook, a demo, a proof and a
 * call to action, in that order — never existed as a single video anywhere.
 *
 * On-screen text is burned here for the same reason. `Shot.onScreenText` is a
 * separate channel from `voiceover` precisely because a beat can be silent and
 * still have words in frame; nothing has ever drawn them.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ─────────────────────────────────────
 *
 * It does not mux narration. `Shot.voiceover` is WORDS, not audio: turning it
 * into a track means a TTS generation per beat, which is a charge per beat and
 * belongs to the estimate a reviewer approves, not to a post-processing step
 * that quietly spends.
 *
 * What it DOES carry is whatever audio the clips already have — and that is the
 * fiddly part, because they disagree. A model asked for audio returns a track
 * and one that was not returns none, inside a single concept; concat requires
 * every input to have the same streams, so a silent beat gets silence GENERATED
 * for exactly its own length rather than being joined as a video-only segment,
 * which fails the graph outright.
 *
 * ── SECURITY POSTURE ───────────────────────────────────────────────────────
 *
 * The same as MediaProbeService, and for the same reason: ffmpeg's protocol
 * handlers (`concat:`, `file:`, `subfile:`) make a URL-fed ffmpeg an arbitrary
 * read. Every input is fetched through `safeFetch` first and ffmpeg only ever
 * sees local paths. Text is passed by `textfile=` rather than interpolated into
 * the filter graph — a caption written in Turkish routinely contains the very
 * characters (`:`, `'`, `%`, `\`) that would otherwise have to be escaped by
 * hand into a filter string, and getting that wrong is a broken render at best.
 */

/** Flat by design — `strictNullChecks` is off, so a union would not narrow. */
export interface AssemblyResult {
  /** Local path of the finished file. The caller uploads and deletes it. */
  path: string | null;
  error: string | null;
}

export interface AssemblyClip {
  url: string;
  /** Words the viewer READS, burned into this beat's frames. */
  onScreenText?: string | null;
}

/** Output frame for each ratio the shot planner can ask for. Even numbers
 *  throughout: libx264 with yuv420p cannot encode an odd dimension. */
const FRAME: Record<string, { w: number; h: number }> = {
  '9:16': { w: 1080, h: 1920 },
  '16:9': { w: 1920, h: 1080 },
  '1:1': { w: 1080, h: 1080 },
  '4:5': { w: 1080, h: 1350 },
  '4:3': { w: 1440, h: 1080 },
  '3:4': { w: 1080, h: 1440 },
  '21:9': { w: 2560, h: 1080 },
};
const DEFAULT_FRAME = FRAME['9:16'];

/** DejaVu covers the Turkish alphabet (ğ ş ı İ ç ö ü), which the customers of
 *  this product write in. Installed in the production image beside ffmpeg. */
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

/** One clip as the assembler sees it: on disk, and measured. */
interface ClipInput {
  path: string;
  durationSec: number;
  hasAudio: boolean;
}

/** Every segment's audio is forced to one shape before concat, because concat
 *  rejects inputs whose rate, layout or sample format differ — and the models
 *  in this catalogue do not agree on any of the three. */
const AUDIO_LAYOUT = 'r=44100:cl=stereo';
const AUDIO_NORMALISE = 'aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo';

const FETCH_TIMEOUT_MS = 60_000;
/** Generous: this is N clips re-encoded, and it runs in a scheduled job rather
 *  than a request. Bounded all the same, so a pathological input cannot hold a
 *  worker forever. */
const RENDER_TIMEOUT_MS = 10 * 60_000;
const MAX_CLIP_BYTES = 256 * 1024 * 1024;
/** Past this, the filter graph and the render time stop being reasonable — and
 *  a concept with more beats than this is a planning fault, not a video. */
const MAX_CLIPS = 12;

@Injectable()
export class VideoAssemblyService {
  private readonly logger = new Logger(VideoAssemblyService.name);

  constructor(private readonly probe: MediaProbeService) {}

  /**
   * Concatenate `clips` in order into one file, burning each beat's on-screen
   * text over its own frames.
   *
   * Never throws: assembly is an improvement on publishing the clips loose, and
   * a failure here must leave that fallback available rather than take a post
   * down with it.
   */
  async assemble(clips: AssemblyClip[], aspectRatio?: string): Promise<AssemblyResult> {
    const fail = (error: string): AssemblyResult => ({ path: null, error });
    if (!Array.isArray(clips) || clips.length < 2) {
      // One clip is already the video. Assembling it would re-encode for nothing.
      return fail('nothing to assemble: fewer than two clips');
    }
    if (clips.length > MAX_CLIPS) return fail(`too many clips to assemble (${clips.length} > ${MAX_CLIPS})`);

    const scratch: string[] = [];
    try {
      const inputs: ClipInput[] = [];
      for (const clip of clips) {
        const p = await this.download(clip.url);
        scratch.push(p);
        // Measured from the file already on disk — the assembler downloaded it,
        // so fetching it again to measure it would double the transfer.
        const m = await this.probe.measureFile(p);
        if (m.error || !m.durationSec) {
          return fail(`a clip could not be read before assembly: ${m.error ?? 'no duration'}`);
        }
        inputs.push({ path: p, durationSec: m.durationSec, hasAudio: m.hasAudio });
      }

      const textFiles: (string | null)[] = [];
      for (const clip of clips) {
        const text = (clip.onScreenText ?? '').trim();
        if (!text) {
          textFiles.push(null);
          continue;
        }
        const tf = join(tmpdir(), `assembly-text-${randomUUID()}.txt`);
        await fs.writeFile(tf, text, 'utf8');
        scratch.push(tf);
        textFiles.push(tf);
      }

      const out = join(tmpdir(), `assembly-${randomUUID()}.mp4`);
      const frame = FRAME[aspectRatio ?? ''] ?? DEFAULT_FRAME;
      const args = buildFfmpegArgs(inputs, textFiles, frame, out);

      const err = await this.run(args);
      if (err) {
        await fs.unlink(out).catch(() => undefined);
        return fail(err);
      }
      return { path: out, error: null };
    } catch (e: any) {
      return fail(String(e?.message ?? e).slice(0, 300));
    } finally {
      for (const p of scratch) await fs.unlink(p).catch(() => undefined);
    }
  }

  private async download(url: string): Promise<string> {
    const res = await safeFetch(url, { timeoutMs: FETCH_TIMEOUT_MS });
    if (!res.ok) throw new Error(`clip fetch failed: HTTP ${res.status}`);
    const path = join(tmpdir(), `assembly-in-${randomUUID()}`);
    const handle = await fs.open(path, 'w');
    try {
      let total = 0;
      for await (const chunk of (res.body ?? []) as AsyncIterable<Uint8Array>) {
        total += chunk.length;
        if (total > MAX_CLIP_BYTES) throw new Error('a clip is larger than the assembly limit');
        await handle.write(chunk);
      }
      if (total === 0) throw new Error('a clip downloaded empty');
    } finally {
      await handle.close().catch(() => undefined);
    }
    return path;
  }

  /** Returns null on success, or ffmpeg's own last words. */
  private run(args: string[]): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      execFile('ffmpeg', args, { timeout: RENDER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) => {
        if (!err) return resolve(null);
        if ((err as any).code === 'ENOENT') return resolve('ffmpeg is not installed on this server');
        // ffmpeg says what it could not do on the LAST lines of stderr; the rest
        // is a banner nobody needs in a database column.
        const tail = String(stderr ?? '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
        resolve(tail || String(err.message).slice(0, 300));
      });
    });
  }
}

/**
 * The filter graph, built rather than templated so the tests can read it.
 *
 * Every clip is normalised before it is joined: the models in this catalogue do
 * not agree on resolution, frame rate, pixel format or sample aspect, and
 * ffmpeg's concat filter requires its inputs to match exactly. `scale` +
 * `pad` fits each clip inside the target frame without cropping or stretching
 * it — a beat rendered 16:9 by a model that ignored the aspect request appears
 * letterboxed rather than with its subject sliced off.
 */
export function buildFfmpegArgs(
  inputs: ClipInput[],
  textFiles: (string | null)[],
  frame: { w: number; h: number },
  out: string,
): string[] {
  const args: string[] = ['-v', 'error', '-y'];
  for (const c of inputs) args.push('-i', c.path);

  const chains: string[] = [];
  const labels: string[] = [];
  inputs.forEach((clip, i) => {
    const steps = [
      `scale=${frame.w}:${frame.h}:force_original_aspect_ratio=decrease`,
      `pad=${frame.w}:${frame.h}:(ow-iw)/2:(oh-ih)/2:color=black`,
      'setsar=1',
      'fps=30',
      'format=yuv420p',
    ];
    const tf = textFiles[i];
    if (tf) {
      // textfile, never `text=`: the caption is customer copy and routinely
      // contains the characters that terminate a filter argument.
      steps.push(
        [
          `drawtext=fontfile=${FONT}`,
          `textfile=${tf}`,
          'fontcolor=white',
          `fontsize=${Math.round(frame.h / 22)}`,
          'box=1',
          'boxcolor=black@0.45',
          `boxborderw=${Math.round(frame.h / 90)}`,
          'x=(w-text_w)/2',
          // Above the platform's own bottom furniture, which sits over roughly
          // the last eighth of a vertical frame.
          'y=h-text_h-(h/6)',
          'line_spacing=8',
        ].join(':'),
      );
    }
    chains.push(`[${i}:v]${steps.join(',')}[v${i}]`);

    // One audio label per segment, whatever the clip brought. A silent beat
    // gets silence of ITS OWN length: concat lines the streams up segment by
    // segment, so a shorter or endless filler would slide the audio out of step
    // with the picture from that beat onward.
    if (clip.hasAudio) {
      chains.push(`[${i}:a]${AUDIO_NORMALISE},asetpts=PTS-STARTPTS[a${i}]`);
    } else {
      chains.push(
        `anullsrc=${AUDIO_LAYOUT},atrim=duration=${clip.durationSec.toFixed(3)},${AUDIO_NORMALISE}[a${i}]`,
      );
    }
    labels.push(`[v${i}][a${i}]`);
  });

  chains.push(`${labels.join('')}concat=n=${inputs.length}:v=1:a=1[out][aout]`);

  args.push(
    '-filter_complex', chains.join(';'),
    '-map', '[out]',
    '-map', '[aout]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    // Every platform this publishes to streams the file; without this the moov
    // atom lands at the end and the first frame waits for the whole download.
    '-movflags', '+faststart',
    out,
  );
  return args;
}
