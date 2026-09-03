import { parseProbeJson } from './media-probe.service';

/**
 * The five source-metered models were withheld because a hand-written container
 * parser could not measure a file soundly — it invented durations for ordinary
 * phone videos and a decoy box walked it into a 600x under-charge. What replaced
 * it reads ffprobe's own answer, and the contract that matters is what it does
 * when that answer is absent or partial: refuse, never guess.
 */
describe('reading what ffprobe actually reported', () => {
  const ok = (format: unknown, streams: unknown[] = []) =>
    parseProbeJson(JSON.stringify({ format, streams }));

  it('measures a normal video', () => {
    expect(ok({ duration: '12.44' }, [
      { codec_type: 'video', width: 1920, height: 1080 },
      { codec_type: 'audio' },
    ])).toEqual({
      durationSec: 12.44, width: 1920, height: 1080, hasAudio: true, error: null,
    });
  });

  it('skips the audio stream to find the one with dimensions', () => {
    // A video file's stream list routinely leads with audio, and can carry
    // attached cover art. Taking streams[0] measures the wrong thing.
    const r = ok({ duration: '5' }, [
      { codec_type: 'audio' },
      { codec_type: 'video', width: 1080, height: 1920 },
    ]);
    expect(r).toMatchObject({ width: 1080, height: 1920 });
  });

  it('reads a still image, which has dimensions and no duration', () => {
    expect(ok({}, [{ codec_type: 'video', width: 4000, height: 3000 }])).toEqual({
      durationSec: null, width: 4000, height: 3000, hasAudio: false, error: null,
    });
  });

  it('treats "N/A" as no measurement rather than as a number', () => {
    const r = ok({ duration: 'N/A' }, [{ width: 640, height: 480 }]);
    expect(r.durationSec).toBeNull();
  });

  it('refuses a zero duration instead of reporting a successful measurement of nothing', () => {
    // Zero would bill a per-second model for nothing AND look like it worked.
    const r = ok({ duration: '0' }, [{ width: 640, height: 480 }]);
    expect(r.durationSec).toBeNull();
  });

  it('ignores a stream whose dimensions are zero', () => {
    const r = ok({ duration: '3' }, [{ width: 0, height: 0 }]);
    expect(r.width).toBeNull();
    expect(r.height).toBeNull();
  });

  it('reports whether there is an audio stream at all', () => {
    // Not for pricing — for assembly. A silent clip joined to one with sound
    // fails the concat graph unless silence is generated for it.
    expect(ok({ duration: '5' }, [{ codec_type: 'video', width: 8, height: 8 }]).hasAudio).toBe(false);
    expect(ok({ duration: '5' }, [
      { codec_type: 'video', width: 8, height: 8 }, { codec_type: 'audio' },
    ]).hasAudio).toBe(true);
  });

  it('errors when the file yielded neither a duration nor a size', () => {
    // The caller must be able to tell "measured, and it has no duration" from
    // "could not measure" — one is priceable, the other must refuse.
    const r = ok({}, []);
    expect(r.error).toMatch(/could not measure/i);
    expect(r.durationSec).toBeNull();
  });

  it('errors rather than throwing when ffprobe printed nothing usable', () => {
    expect(parseProbeJson('')).toMatchObject({ error: expect.stringMatching(/no readable output/i) });
    expect(parseProbeJson('not json at all')).toMatchObject({ error: expect.any(String) });
  });

  it('never returns a partial measurement alongside an error', () => {
    // A caller that reads the numbers without checking `error` must not be able
    // to bill on a half-answer.
    const bad = parseProbeJson('{');
    expect(bad.durationSec).toBeNull();
    expect(bad.width).toBeNull();
    expect(bad.height).toBeNull();
  });
});
