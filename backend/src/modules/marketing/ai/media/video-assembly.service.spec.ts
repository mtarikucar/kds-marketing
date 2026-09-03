import { buildFfmpegArgs } from './video-assembly.service';

/**
 * The filter graph is where this feature is right or wrong, and it is not
 * something you can eyeball in production: a graph that is subtly off does not
 * error, it renders a video with the audio a beat out of step, or the caption
 * off-frame, or one clip stretched.
 */
describe('the filter graph that joins a concept into one video', () => {
  const frame = { w: 1080, h: 1920 };
  const clip = (over: Partial<{ path: string; durationSec: number; hasAudio: boolean }> = {}) => ({
    path: over.path ?? '/tmp/a.mp4',
    durationSec: over.durationSec ?? 5,
    hasAudio: over.hasAudio ?? true,
  });
  const graph = (args: string[]) => args[args.indexOf('-filter_complex') + 1];

  it('feeds every clip in as its own input, in order', () => {
    const args = buildFfmpegArgs(
      [clip({ path: '/tmp/hook.mp4' }), clip({ path: '/tmp/cta.mp4' })],
      [null, null], frame, '/tmp/out.mp4',
    );
    const inputs = args.reduce<string[]>((acc, a, i) => (a === '-i' ? [...acc, args[i + 1]] : acc), []);
    expect(inputs).toEqual(['/tmp/hook.mp4', '/tmp/cta.mp4']);
  });

  it('normalises every clip to the same frame before joining them', () => {
    // concat refuses inputs whose size, rate or sample aspect differ, and the
    // models in this catalogue do not agree on any of those.
    const g = graph(buildFfmpegArgs([clip(), clip()], [null, null], frame, '/tmp/o.mp4'));
    expect(g).toContain('scale=1080:1920:force_original_aspect_ratio=decrease');
    expect(g).toContain('pad=1080:1920');
    expect(g).toContain('setsar=1');
    expect(g).toContain('fps=30');
  });

  it('fits the clip inside the frame rather than cropping it', () => {
    // A beat a model rendered 16:9 despite the request must arrive letterboxed,
    // not with its subject sliced off.
    const g = graph(buildFfmpegArgs([clip(), clip()], [null, null], frame, '/tmp/o.mp4'));
    expect(g).toContain('force_original_aspect_ratio=decrease');
    expect(g).not.toContain('crop=');
  });

  it('renders each frame size the planner can ask for', () => {
    const wide = buildFfmpegArgs([clip(), clip()], [null, null], { w: 1920, h: 1080 }, '/tmp/o.mp4');
    expect(graph(wide)).toContain('scale=1920:1080');
  });

  describe('audio', () => {
    it('carries a clip’s own track through', () => {
      const g = graph(buildFfmpegArgs([clip(), clip()], [null, null], frame, '/tmp/o.mp4'));
      expect(g).toContain('[0:a]');
      expect(g).toContain('[1:a]');
      expect(g).toContain('concat=n=2:v=1:a=1[out][aout]');
    });

    it('generates silence of the SILENT clip’s own length', () => {
      // concat lines streams up segment by segment. Filler of the wrong length
      // slides the audio out of step with the picture from that beat onward,
      // and endless filler never ends the segment at all.
      const g = graph(buildFfmpegArgs(
        [clip({ hasAudio: false, durationSec: 4.25 }), clip()],
        [null, null], frame, '/tmp/o.mp4',
      ));
      expect(g).toContain('anullsrc=r=44100:cl=stereo');
      expect(g).toContain('atrim=duration=4.250');
      // The clip that HAS audio still uses its own.
      expect(g).toContain('[1:a]');
    });

    it('forces one audio shape on every segment', () => {
      // Rate, layout and sample format all have to match or concat refuses.
      const g = graph(buildFfmpegArgs(
        [clip({ hasAudio: false }), clip({ hasAudio: true })],
        [null, null], frame, '/tmp/o.mp4',
      ));
      const normalisations = g.split('aformat=sample_fmts=fltp:channel_layouts=stereo').length - 1;
      expect(normalisations).toBe(2);
    });

    it('maps both streams out, and encodes audio the platforms accept', () => {
      const args = buildFfmpegArgs([clip(), clip()], [null, null], frame, '/tmp/o.mp4');
      expect(args).toEqual(expect.arrayContaining(['-map', '[out]', '-map', '[aout]', '-c:a', 'aac']));
    });
  });

  describe('on-screen text', () => {
    it('draws a beat’s words over that beat only', () => {
      const g = graph(buildFfmpegArgs(
        [clip(), clip()], ['/tmp/t0.txt', null], frame, '/tmp/o.mp4',
      ));
      const [chain0, chain1] = g.split(';');
      expect(chain0).toContain('drawtext');
      expect(chain1).not.toContain('drawtext');
    });

    it('passes the words by FILE, never interpolated into the graph', () => {
      // Captions are customer copy. A Turkish one routinely contains `:` and
      // `'` — the characters that terminate a filter argument — so a `text=`
      // form would be a broken render on ordinary input, not on a hostile one.
      const g = graph(buildFfmpegArgs([clip(), clip()], ['/tmp/t0.txt', null], frame, '/tmp/o.mp4'));
      expect(g).toContain('textfile=/tmp/t0.txt');
      // `:text=` is the parameter form. (`drawtext=` contains the letters
      // "text=" too, which is why this looks for the separator.)
      expect(g).not.toContain(':text=');
    });

    it('names a font file, because drawtext fails the render without one', () => {
      const g = graph(buildFfmpegArgs([clip(), clip()], ['/tmp/t.txt', null], frame, '/tmp/o.mp4'));
      expect(g).toContain('fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf');
    });

    it('keeps the caption clear of the platform’s own bottom furniture', () => {
      const g = graph(buildFfmpegArgs([clip(), clip()], ['/tmp/t.txt', null], frame, '/tmp/o.mp4'));
      expect(g).toContain('y=h-text_h-(h/6)');
      expect(g).toContain('x=(w-text_w)/2');
    });
  });

  it('writes a file every platform can start playing before it has all of it', () => {
    const args = buildFfmpegArgs([clip(), clip()], [null, null], frame, '/tmp/out.mp4');
    expect(args).toEqual(expect.arrayContaining(['-movflags', '+faststart', '-pix_fmt', 'yuv420p']));
    expect(args[args.length - 1]).toBe('/tmp/out.mp4');
  });

  it('overwrites its own output rather than stalling on a prompt', () => {
    // Without -y ffmpeg asks on stdin, and nothing is listening in a job.
    expect(buildFfmpegArgs([clip(), clip()], [null, null], frame, '/tmp/o.mp4')).toContain('-y');
  });
});
