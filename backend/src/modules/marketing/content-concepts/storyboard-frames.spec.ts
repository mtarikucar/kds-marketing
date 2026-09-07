import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import {
  MAX_FRAME_ATTEMPTS,
  MAX_SHOT_TEXT,
  abandonRequested,
  frameSeed,
  frameWanted,
  framesReady,
  isRefusal,
  markRequested,
  resetExhaustedFrames,
  submitMissingFrames,
  supportsStoryboard,
  syncFrames,
  writeKeyframe,
  writeShotText,
} from './storyboard-frames';
import { DEFAULT_KEYFRAME_MODEL, DEFAULT_KEYFRAME_REFERENCE_MODEL } from '../ai/media/media-models.config';
import type { Keyframe, ShotPlan } from '../video/video-pipeline.service';

const WS = 'ws-1';
const CONCEPT = 'concept-1';
const SINCE = new Date('2026-09-01T00:00:00Z');
const LINK = { socialCampaignId: 'camp-1', createdById: 'u1', since: SINCE };

function plan(over: Partial<ShotPlan> = {}): ShotPlan {
  return {
    model: 'seedance', aspectRatio: '9:16', durationSec: 5, captionSuggestion: 'x', qcChecklist: [],
    storyboard: { imageModel: DEFAULT_KEYFRAME_MODEL, seed: 100 },
    shots: [
      { ord: 0, scene: '0-2s', voiceover: '', prompt: 'clip a', keyframePrompt: 'still a', durationSec: 2, cameraNote: 'w' },
      { ord: 1, scene: '2-5s', voiceover: '', prompt: 'clip b', keyframePrompt: 'still b', durationSec: 3, cameraNote: 'm' },
    ],
    ...over,
  };
}
const queueFull = () => new BadRequestException({ code: 'MEDIA_GEN_TOO_MANY', message: 'full' });

/** A prisma fake whose `$executeRaw` accepts every write (1 row) unless told otherwise. */
function db(rows: unknown[] = []) {
  return {
    $executeRaw: jest.fn().mockResolvedValue(1),
    generatedAsset: { findMany: jest.fn().mockResolvedValue(rows) },
  };
}
/** Every keyframe write, decoded off the tagged template's values: the beat
 *  index, the keyframe written, and the compare-and-set the write carried. */
function kfWrites(prisma: { $executeRaw: jest.Mock }) {
  return prisma.$executeRaw.mock.calls
    .filter((c: unknown[]) => /^\d+$/.test(String(c[1])) && (c[0] as string[]).join('?').includes("'keyframe'"))
    .map((c: unknown[]) => ({
      idx: Number(c[1]),
      keyframe: JSON.parse(String(c[2])) as Keyframe,
      expect: { assetId: c[8], status: c[10] },
    }));
}
const sql = (prisma: { $executeRaw: jest.Mock }, n = 0) => (prisma.$executeRaw.mock.calls[n][0] as string[]).join('?');

describe('supportsStoryboard', () => {
  it('is true only for a plan that carries the storyboard record and a prompt per beat', () => {
    expect(supportsStoryboard(plan())).toBe(true);
    expect(supportsStoryboard({ ...plan(), storyboard: undefined })).toBe(false);
    const p = plan();
    delete p.shots[1].keyframePrompt;
    expect(supportsStoryboard(p)).toBe(false);
    expect(supportsStoryboard(null)).toBe(false);
  });
});

describe('frameWanted / frameSeed / isRefusal', () => {
  const kf = (over: Partial<Keyframe>): Keyframe => ({ assetId: 'a', status: 'READY', model: 'm', attempts: 1, ...over });

  it('wants a beat with no frame, a merely requested one, or one refused under the cap — never one in flight, READY, or exhausted', () => {
    expect(frameWanted(undefined)).toBe(true);
    expect(frameWanted(kf({ assetId: '', status: 'QUEUED', attempts: 0 }))).toBe(true);
    expect(frameWanted(kf({ status: 'QUEUED' }))).toBe(false);
    expect(frameWanted(kf({ status: 'GENERATING' }))).toBe(false);
    expect(frameWanted(kf({ status: 'READY' }))).toBe(false);
    expect(frameWanted(kf({ status: 'FAILED', attempts: 1 }))).toBe(true);
    expect(frameWanted(kf({ status: 'BLOCKED', attempts: 1 }))).toBe(true);
    expect(frameWanted(kf({ status: 'FAILED', attempts: MAX_FRAME_ATTEMPTS }))).toBe(false);
    expect(frameWanted(kf({ assetId: '', status: 'FAILED', attempts: MAX_FRAME_ATTEMPTS }))).toBe(false);
  });

  it('draws the first attempt with the seed as given and NUDGES every automatic retry, so a refusal is not resubmitted verbatim', () => {
    const sb = { imageModel: 'm', seed: 5 };
    expect(frameSeed(sb, undefined)).toBe(5);
    // A human's fresh seed, first draw: used as is.
    expect(frameSeed(sb, kf({ assetId: '', status: 'QUEUED', attempts: 0, seed: 999 }))).toBe(999);
    // The retry after a refusal drawn with seed 5: nudged off 5.
    expect(frameSeed(sb, kf({ status: 'FAILED', attempts: 1, seed: 5 }))).toBe(5 + 104729);
    // …and off the human's seed when that is what was refused.
    expect(frameSeed(sb, kf({ status: 'FAILED', attempts: 1, seed: 999 }))).toBe(999 + 104729);
    expect(frameSeed(sb, kf({ status: 'FAILED', attempts: 1 }))).toBe(5 + 104729);
  });

  it('a refusal is a BadRequest that is not queue-full; an outage, a config gap or a plain Error is the weather', () => {
    expect(isRefusal(new BadRequestException('bad ratio'))).toBe(true);
    expect(isRefusal(queueFull())).toBe(false);
    expect(isRefusal(new ServiceUnavailableException({ code: 'MEDIA_GEN_NOT_CONFIGURED' }))).toBe(false);
    expect(isRefusal(new Error('ECONNRESET'))).toBe(false);
  });
});

describe('writeKeyframe — one beat, compare-and-set', () => {
  it('sets only that beat path, guards the ord at the index, and compares the keyframe the caller read', async () => {
    const prisma = db();
    const prev: Keyframe = { assetId: 'old', status: 'FAILED', model: 'm', attempts: 1 };
    const next: Keyframe = { assetId: 'new', status: 'QUEUED', model: 'm', attempts: 2 };
    await expect(writeKeyframe({ prisma: prisma as never }, WS, CONCEPT, 1, 1, next, prev)).resolves.toBe(true);
    const text = sql(prisma);
    expect(text).toContain('jsonb_set("shotPlan", ARRAY[\'shots\', ?, \'keyframe\']::text[]');
    expect(text).toContain("->> 'ord')::int = ?::int");
    expect(text).toContain("->> 'assetId', '') = ?");
    expect(text).toContain("->> 'status', '') = ?");
    expect(text).toContain("->> 'seed', '') = ?");
    expect(kfWrites(prisma)).toEqual([{ idx: 1, keyframe: next, expect: { assetId: 'old', status: 'FAILED' } }]);
    // No seed on what was read: compared against the empty string.
    expect(prisma.$executeRaw.mock.calls[0][12]).toBe('');
  });

  it('the SEED is part of the compare-and-set: a redraw marker with a fresh seed is not the marker the job read', async () => {
    const prisma = db();
    const readByJob: Keyframe = { assetId: '', status: 'QUEUED', model: 'm', attempts: 0 };
    const humanReset: Keyframe = { assetId: '', status: 'QUEUED', model: 'm', attempts: 0, seed: 4242 };
    await writeKeyframe({ prisma: prisma as never }, WS, CONCEPT, 0, 0, { assetId: 'bought', status: 'QUEUED', model: 'm', attempts: 1 }, readByJob);
    await writeKeyframe({ prisma: prisma as never }, WS, CONCEPT, 0, 0, { assetId: 'bought', status: 'QUEUED', model: 'm', attempts: 1 }, humanReset);
    expect(prisma.$executeRaw.mock.calls.map((c: unknown[]) => c[12])).toEqual(['', '4242']);
  });

  it('a beat that had no keyframe is compared against the empty pair, and a lost race reports false', async () => {
    const prisma = db();
    prisma.$executeRaw.mockResolvedValueOnce(0);
    const next: Keyframe = { assetId: 'new', status: 'QUEUED', model: 'm', attempts: 1 };
    await expect(writeKeyframe({ prisma: prisma as never }, WS, CONCEPT, 0, 0, next, null)).resolves.toBe(false);
    expect(kfWrites(prisma)[0].expect).toEqual({ assetId: '', status: '' });
  });
});

describe('submitMissingFrames', () => {
  it('requests one IMAGE per frameless beat with the still prompt, the shared seed and the linkage — and writes EACH keyframe onto the row as it lands', async () => {
    const mediaGen = { requestGeneration: jest.fn().mockResolvedValueOnce({ assetId: 'f0' }).mockResolvedValueOnce({ assetId: 'f1' }) };
    const prisma = db();
    const res = await submitMissingFrames({ mediaGen, prisma: prisma as never }, WS, CONCEPT, plan() as never, LINK);
    expect(res).toMatchObject({ submitted: 2, adopted: 0, queueFull: false, conflicted: false });
    expect(mediaGen.requestGeneration).toHaveBeenNthCalledWith(1, WS, {
      type: 'IMAGE', model: DEFAULT_KEYFRAME_MODEL, prompt: 'still a', aspectRatio: '9:16', seed: 100,
      socialCampaignId: 'camp-1', createdById: 'u1',
    });
    expect(kfWrites(prisma)).toEqual([
      { idx: 0, keyframe: { assetId: 'f0', status: 'QUEUED', model: DEFAULT_KEYFRAME_MODEL, seed: 100, attempts: 1 }, expect: { assetId: '', status: '' } },
      { idx: 1, keyframe: { assetId: 'f1', status: 'QUEUED', model: DEFAULT_KEYFRAME_MODEL, seed: 100, attempts: 1 }, expect: { assetId: '', status: '' } },
    ]);
    expect(res.plan.shots[1].keyframe?.assetId).toBe('f1');
    // The orphan search is bounded by the concept's own birth.
    expect(prisma.generatedAsset.findMany.mock.calls[0][0].where.createdAt).toEqual({ gte: SINCE });
  });

  it('sends persona photos only to a frame model whose contract takes an array of them', async () => {
    const refs = ['https://cdn/p1.jpg'];
    const shots = plan().shots.map((sh) => ({ ...sh, reference: { images: refs, seed: 7 } }));
    const mediaGen = { requestGeneration: jest.fn().mockResolvedValue({ assetId: 'f' }) };
    await submitMissingFrames({ mediaGen, prisma: db() as never }, WS, CONCEPT, plan({ shots, storyboard: { imageModel: DEFAULT_KEYFRAME_REFERENCE_MODEL, seed: 7 } }) as never, LINK);
    expect(mediaGen.requestGeneration.mock.calls[0][1]).toMatchObject({ model: DEFAULT_KEYFRAME_REFERENCE_MODEL, referenceImageUrls: refs });
    mediaGen.requestGeneration.mockClear();
    await submitMissingFrames({ mediaGen, prisma: db() as never }, WS, CONCEPT, plan({ shots }) as never, LINK);
    expect(mediaGen.requestGeneration.mock.calls[0][1]).not.toHaveProperty('referenceImageUrls');
  });

  it('stops at a full queue and reports it, leaving the rest untouched and unwritten', async () => {
    const mediaGen = { requestGeneration: jest.fn().mockRejectedValueOnce(queueFull()) };
    const prisma = db();
    const res = await submitMissingFrames({ mediaGen, prisma: prisma as never }, WS, CONCEPT, plan() as never, LINK);
    expect(res).toMatchObject({ submitted: 0, queueFull: true });
    expect(res.plan.shots.every((sh) => sh.keyframe === undefined)).toBe(true);
    expect(mediaGen.requestGeneration).toHaveBeenCalledTimes(1);
    expect(kfWrites(prisma)).toEqual([]);
  });

  it('records a REFUSAL as a FAILED attempt with the reason and moves on to the next beat', async () => {
    const mediaGen = { requestGeneration: jest.fn().mockRejectedValueOnce(new BadRequestException('bad ratio')).mockResolvedValueOnce({ assetId: 'f1' }) };
    const prisma = db();
    const res = await submitMissingFrames({ mediaGen, prisma: prisma as never }, WS, CONCEPT, plan() as never, LINK);
    expect(res.plan.shots[0].keyframe).toMatchObject({ status: 'FAILED', attempts: 1, error: 'bad ratio' });
    expect(res.plan.shots[1].keyframe?.status).toBe('QUEUED');
    expect(res.halted).toBeUndefined();
    expect(kfWrites(prisma).map((w) => w.keyframe.status)).toEqual(['FAILED', 'QUEUED']);
  });

  it('the WEATHER — an outage, a config gap — halts the pass without spending an attempt, and every beat still merely requested is told why', async () => {
    const p = plan();
    p.shots[1].keyframe = { assetId: '', status: 'QUEUED', model: DEFAULT_KEYFRAME_MODEL, attempts: 1, seed: 100 };
    const mediaGen = { requestGeneration: jest.fn().mockRejectedValueOnce(new ServiceUnavailableException('Media generation is not configured')) };
    const prisma = db();
    const res = await submitMissingFrames({ mediaGen, prisma: prisma as never }, WS, CONCEPT, p as never, LINK);
    expect(res.halted).toEqual({ ord: 0, why: 'Media generation is not configured' });
    expect(mediaGen.requestGeneration).toHaveBeenCalledTimes(1);
    expect(res.plan.shots[0].keyframe).toMatchObject({ assetId: '', status: 'FAILED', attempts: 0, error: 'Media generation is not configured' });
    // Beat 1 was requested and had one attempt spent already: it keeps that count.
    expect(res.plan.shots[1].keyframe).toMatchObject({ status: 'FAILED', attempts: 1, error: 'Media generation is not configured' });
    expect(frameWanted(res.plan.shots[0].keyframe)).toBe(true);
    expect(kfWrites(prisma)).toHaveLength(2);
  });

  it('re-requests a refused frame with a nudged seed until the attempt cap, then leaves it alone', async () => {
    const p = plan();
    p.shots[0].keyframe = { assetId: 'old', status: 'FAILED', model: DEFAULT_KEYFRAME_MODEL, attempts: 1 };
    p.shots[1].keyframe = { assetId: 'done', status: 'READY', url: 'https://r2/b.png', model: DEFAULT_KEYFRAME_MODEL, attempts: 1 };
    const mediaGen = { requestGeneration: jest.fn().mockResolvedValue({ assetId: 'f0b' }) };
    const prisma = db();
    const res = await submitMissingFrames({ mediaGen, prisma: prisma as never }, WS, CONCEPT, p as never, { ...LINK, campaignItemId: 'item-1' });
    expect(mediaGen.requestGeneration).toHaveBeenCalledTimes(1);
    expect(mediaGen.requestGeneration.mock.calls[0][1]).toMatchObject({ seed: (100 + 104729) % 2147483647, campaignItemId: 'item-1' });
    expect(res.plan.shots[0].keyframe).toMatchObject({ assetId: 'f0b', status: 'QUEUED', attempts: 2 });
    // Compared against the refused keyframe it read, not against "nothing".
    expect(kfWrites(prisma)[0].expect).toEqual({ assetId: 'old', status: 'FAILED' });
  });

  it("scope 'requested' draws only beats a human asked for — a beat nobody asked for is left to the producer", async () => {
    const p = plan();
    p.shots[1].keyframe = { assetId: '', status: 'QUEUED', model: DEFAULT_KEYFRAME_MODEL, attempts: 0 };
    const mediaGen = { requestGeneration: jest.fn().mockResolvedValue({ assetId: 'f1' }) };
    const res = await submitMissingFrames({ mediaGen, prisma: db() as never }, WS, CONCEPT, p as never, LINK, { scope: 'requested' });
    expect(mediaGen.requestGeneration.mock.calls.map((c) => c[1].prompt)).toEqual(['still b']);
    expect(res.submitted).toBe(1);
    expect(res.plan.shots[0].keyframe).toBeUndefined();
    // The producer's default scope wants both.
    mediaGen.requestGeneration.mockClear();
    await submitMissingFrames({ mediaGen, prisma: db() as never }, WS, CONCEPT, p as never, LINK);
    expect(mediaGen.requestGeneration.mock.calls.map((c) => c[1].prompt)).toEqual(['still a', 'still b']);
  });

  it('ADOPTS a frame this beat already bought but never recorded — same model, prompt, seed, born after the concept, claimed by no other beat — instead of buying again', async () => {
    const p = plan();
    p.shots[1].keyframe = { assetId: 'orphan-b', status: 'READY', url: 'u', model: DEFAULT_KEYFRAME_MODEL, attempts: 1 };
    const prisma = db();
    prisma.generatedAsset.findMany.mockImplementation(async ({ where }: { where: { prompt: string } }) =>
      where.prompt === 'still a'
        ? [
            // Wrong seed: another concept's draw of the same words.
            { id: 'other-seed', status: 'READY', url: 'x', params: { seed: 4 } },
            // Already beat 1's — never adopted twice.
            { id: 'orphan-b', status: 'READY', url: 'u', params: { seed: 100 } },
            { id: 'orphan-a', status: 'GENERATING', url: null, params: { seed: 100 } },
          ]
        : [],
    );
    const mediaGen = { requestGeneration: jest.fn() };
    const res = await submitMissingFrames({ mediaGen, prisma: prisma as never }, WS, CONCEPT, p as never, LINK);
    expect(mediaGen.requestGeneration).not.toHaveBeenCalled();
    expect(res).toMatchObject({ submitted: 0, adopted: 1 });
    expect(res.plan.shots[0].keyframe).toMatchObject({ assetId: 'orphan-a', status: 'QUEUED', attempts: 1, seed: 100 });
    expect(prisma.generatedAsset.findMany.mock.calls[0][0].where).toMatchObject({
      workspaceId: WS, type: 'IMAGE', prompt: 'still a', status: { in: ['QUEUED', 'GENERATING', 'READY'] }, createdAt: { gte: SINCE },
    });
  });

  it('a plan write that fails right after a buy halts the pass — and the bought frame is adopted, not re-bought, on the next one', async () => {
    const mediaGen = { requestGeneration: jest.fn().mockResolvedValue({ assetId: 'f0' }) };
    const prisma = db();
    prisma.$executeRaw.mockRejectedValueOnce(new Error('connection reset'));
    const first = await submitMissingFrames({ mediaGen, prisma: prisma as never }, WS, CONCEPT, plan() as never, LINK);
    expect(first.halted).toEqual({ ord: 0, why: 'connection reset' });
    expect(first.submitted).toBe(0);
    expect(mediaGen.requestGeneration).toHaveBeenCalledTimes(1);

    // Next pass: the asset row is the record.
    prisma.generatedAsset.findMany.mockImplementation(async ({ where }: { where: { prompt: string } }) =>
      where.prompt === 'still a' ? [{ id: 'f0', status: 'QUEUED', url: null, params: { seed: 100 } }] : [],
    );
    mediaGen.requestGeneration.mockClear();
    const second = await submitMissingFrames({ mediaGen, prisma: prisma as never }, WS, CONCEPT, plan() as never, LINK);
    expect(second.adopted).toBe(1);
    expect(second.plan.shots[0].keyframe?.assetId).toBe('f0');
    expect(mediaGen.requestGeneration.mock.calls.map((c) => c[1].prompt)).toEqual(['still b']);
  });

  it('a beat that changed under the pass is reported as a conflict, not overwritten, and the returned plan does not carry the dropped write', async () => {
    const mediaGen = { requestGeneration: jest.fn().mockResolvedValueOnce({ assetId: 'f0' }).mockResolvedValueOnce({ assetId: 'f1' }) };
    const prisma = db();
    prisma.$executeRaw.mockResolvedValueOnce(0); // beat 0: a redraw landed meanwhile
    const res = await submitMissingFrames({ mediaGen, prisma: prisma as never }, WS, CONCEPT, plan() as never, LINK);
    expect(res.conflicted).toBe(true);
    expect(res.plan.shots[0].keyframe).toBeUndefined();
    expect(res.plan.shots[1].keyframe?.assetId).toBe('f1');
  });
});

describe('syncFrames', () => {
  const withFrames = () => {
    const p = plan();
    p.shots[0].keyframe = { assetId: 'f0', status: 'QUEUED', model: DEFAULT_KEYFRAME_MODEL, attempts: 1 };
    p.shots[1].keyframe = { assetId: 'f1', status: 'QUEUED', model: DEFAULT_KEYFRAME_MODEL, attempts: 1 };
    return p as never;
  };

  it('brings READY frames their URL — written per beat against what it read — counts the rest as pending, and reads only this workspace', async () => {
    const prisma = db([{ id: 'f0', status: 'READY', url: 'https://r2/a.png', error: null }, { id: 'f1', status: 'GENERATING', url: null, error: null }]);
    const res = await syncFrames({ prisma: prisma as never }, WS, CONCEPT, withFrames());
    expect(prisma.generatedAsset.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['f0', 'f1'] }, workspaceId: WS } }));
    expect(res.plan.shots[0].keyframe).toMatchObject({ status: 'READY', url: 'https://r2/a.png' });
    expect(res.plan.shots[1].keyframe?.status).toBe('GENERATING');
    expect(res.pending).toBe(1);
    expect(res.failed).toEqual([]);
    expect(res.changed).toBe(true);
    expect(framesReady(res.plan)).toBe(false);
    const writes = kfWrites(prisma);
    expect(writes.map((w) => [w.idx, w.keyframe.status])).toEqual([[0, 'READY'], [1, 'GENERATING']]);
    expect(writes[0].expect).toEqual({ assetId: 'f0', status: 'QUEUED' });
  });

  it('marks a refused frame FAILED with the vendor reason; it fails BY NAME only once the attempts are spent', async () => {
    const first = await syncFrames({ prisma: db([{ id: 'f0', status: 'BLOCKED', url: null, error: 'nsfw' }, { id: 'f1', status: 'READY', url: 'u', error: null }]) as never }, WS, CONCEPT, withFrames());
    expect(first.plan.shots[0].keyframe).toMatchObject({ status: 'BLOCKED', error: 'nsfw', attempts: 1 });
    expect(first.failed).toEqual([]); // one attempt left
    const p = first.plan;
    p.shots[0].keyframe = { ...p.shots[0].keyframe!, status: 'QUEUED', assetId: 'f0b', attempts: 2 };
    const second = await syncFrames({ prisma: db([{ id: 'f0b', status: 'FAILED', url: null, error: 'boom' }, { id: 'f1', status: 'READY', url: 'u', error: null }]) as never }, WS, CONCEPT, p);
    expect(second.failed).toEqual([{ ord: 0, keyframe: expect.objectContaining({ status: 'FAILED', error: 'boom', attempts: 2 }) }]);
  });

  it('a row that vanished MID-FLIGHT is a refusal; a READY row that vanished (swept, deleted) goes back to wanting at no cost to its attempts', async () => {
    const p = withFrames() as ShotPlan;
    p.shots[1].keyframe = { ...p.shots[1].keyframe!, status: 'READY', url: 'https://r2/b.png', attempts: 2 };
    const res = await syncFrames({ prisma: db([]) as never }, WS, CONCEPT, p as never);
    expect(res.plan.shots[0].keyframe).toMatchObject({ status: 'FAILED', attempts: 1, error: /no longer exists/ });
    expect(res.plan.shots[1].keyframe).toMatchObject({ status: 'FAILED', attempts: 0, error: /no longer exists/ });
    expect(res.plan.shots[1].keyframe?.url).toBeUndefined();
    expect(frameWanted(res.plan.shots[1].keyframe)).toBe(true);
    expect(res.pending).toBe(0);
  });

  it('READY frames ARE re-read (so a swept one is noticed), and a plan whose rows are all still READY is a no-op with no writes', async () => {
    const p = withFrames() as ShotPlan;
    p.shots.forEach((sh) => { sh.keyframe = { ...sh.keyframe!, status: 'READY', url: 'u' }; });
    const prisma = db([{ id: 'f0', status: 'READY', url: 'u', error: null }, { id: 'f1', status: 'READY', url: 'u', error: null }]);
    const res = await syncFrames({ prisma: prisma as never }, WS, CONCEPT, p as never);
    expect(res.changed).toBe(false);
    expect(framesReady(res.plan)).toBe(true);
    expect(prisma.generatedAsset.findMany.mock.calls[0][0].where.id).toEqual({ in: ['f0', 'f1'] });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('a merely REQUESTED beat counts as pending without a row to read; an exhausted one is reported failed', async () => {
    const p = plan();
    p.shots[0].keyframe = { assetId: '', status: 'QUEUED', model: 'm', attempts: 0 };
    p.shots[1].keyframe = { assetId: '', status: 'FAILED', model: 'm', attempts: MAX_FRAME_ATTEMPTS, error: 'twice' };
    const prisma = db();
    const res = await syncFrames({ prisma: prisma as never }, WS, CONCEPT, p as never);
    expect(prisma.generatedAsset.findMany).not.toHaveBeenCalled();
    expect(res.pending).toBe(1);
    expect(res.failed).toEqual([{ ord: 1, keyframe: expect.objectContaining({ error: 'twice' }) }]);
  });

  it('a write it loses (the beat changed meanwhile) is not reported as changed and the plan keeps what was read', async () => {
    const prisma = db([{ id: 'f0', status: 'READY', url: 'u', error: null }, { id: 'f1', status: 'READY', url: 'u', error: null }]);
    prisma.$executeRaw.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const res = await syncFrames({ prisma: prisma as never }, WS, CONCEPT, withFrames());
    expect(res.plan.shots[0].keyframe?.status).toBe('QUEUED');
    expect(res.plan.shots[1].keyframe?.status).toBe('READY');
    expect(res.changed).toBe(true);
  });
});

describe('markRequested / resetExhaustedFrames / abandonRequested', () => {
  it('marks every wanted beat REQUESTED (QUEUED, no asset), carrying its seed and count; skips in-flight, READY, exhausted and already-requested beats', async () => {
    const p = plan({ shots: [
      { ord: 0, scene: 'a', voiceover: '', prompt: 'a', keyframePrompt: 'sa', durationSec: 2, cameraNote: '' },
      { ord: 1, scene: 'b', voiceover: '', prompt: 'b', keyframePrompt: 'sb', durationSec: 2, cameraNote: '', keyframe: { assetId: 'x', status: 'FAILED', model: 'm', attempts: 1, seed: 42, error: 'no' } },
      { ord: 2, scene: 'c', voiceover: '', prompt: 'c', keyframePrompt: 'sc', durationSec: 2, cameraNote: '', keyframe: { assetId: 'y', status: 'GENERATING', model: 'm', attempts: 1 } },
      { ord: 3, scene: 'd', voiceover: '', prompt: 'd', keyframePrompt: 'sd', durationSec: 2, cameraNote: '', keyframe: { assetId: 'z', status: 'FAILED', model: 'm', attempts: MAX_FRAME_ATTEMPTS } },
      { ord: 4, scene: 'e', voiceover: '', prompt: 'e', keyframePrompt: 'se', durationSec: 2, cameraNote: '', keyframe: { assetId: '', status: 'QUEUED', model: 'm', attempts: 0 } },
    ] });
    const prisma = db();
    await expect(markRequested({ prisma: prisma as never }, WS, CONCEPT, p as never)).resolves.toBe(2);
    expect(kfWrites(prisma)).toEqual([
      { idx: 0, keyframe: { assetId: '', status: 'QUEUED', model: DEFAULT_KEYFRAME_MODEL, attempts: 0 }, expect: { assetId: '', status: '' } },
      { idx: 1, keyframe: { assetId: '', status: 'QUEUED', model: DEFAULT_KEYFRAME_MODEL, seed: 42, attempts: 1 }, expect: { assetId: 'x', status: 'FAILED' } },
    ]);
  });

  it('resets ONLY frames that failed for good: a fresh seed, zero attempts, nothing bought', async () => {
    const p = plan();
    p.shots[0].keyframe = { assetId: 'z', status: 'BLOCKED', model: 'm', attempts: MAX_FRAME_ATTEMPTS, seed: 7, error: 'policy' };
    p.shots[1].keyframe = { assetId: 'x', status: 'FAILED', model: 'm', attempts: 1 };
    const prisma = db();
    await expect(resetExhaustedFrames({ prisma: prisma as never }, WS, CONCEPT, p as never)).resolves.toBe(1);
    const [w] = kfWrites(prisma);
    expect(w).toMatchObject({ idx: 0, keyframe: { assetId: '', status: 'QUEUED', attempts: 0 }, expect: { assetId: 'z', status: 'BLOCKED' } });
    expect(w.keyframe.seed).not.toBe(7);
    expect(kfWrites(prisma)).toHaveLength(1);
  });

  it('abandons only the merely requested beats, with the reason and the count untouched', async () => {
    const p = plan();
    p.shots[0].keyframe = { assetId: '', status: 'QUEUED', model: 'm', attempts: 1, seed: 3 };
    p.shots[1].keyframe = { assetId: 'live', status: 'QUEUED', model: 'm', attempts: 1 };
    const prisma = db();
    await expect(abandonRequested({ prisma: prisma as never }, WS, CONCEPT, p as never, 'queue stayed full')).resolves.toBe(1);
    expect(kfWrites(prisma)).toEqual([
      { idx: 0, keyframe: { assetId: '', status: 'FAILED', model: 'm', attempts: 1, seed: 3, error: 'queue stayed full' }, expect: { assetId: '', status: 'QUEUED' } },
    ]);
  });
});

describe('writeShotText — one beat, merged, never the whole plan', () => {
  /** The shot-text write, decoded off the tagged template: the beat index, the
   *  patch merged onto it, and the ord the index is guarded by. */
  const textWrites = (prisma: { $executeRaw: jest.Mock }) =>
    prisma.$executeRaw.mock.calls
      .filter((c: unknown[]) => (c[0] as string[]).join('?').includes('|| ?::jsonb'))
      .map((c: unknown[]) => ({ idx: Number(c[1]), patch: JSON.parse(String(c[3])), ord: c[7] }));

  it('merges only the given keys onto the beat with ||, guards the ord at the index, and keeps the keyframe out of the statement entirely', async () => {
    const prisma = db();
    await expect(
      writeShotText({ prisma: prisma as never }, WS, CONCEPT, 1, 1, { keyframePrompt: 'still b, redrawn', prompt: 'clip b, slower' }),
    ).resolves.toBe(true);
    const text = sql(prisma);
    expect(text).toContain('jsonb_set("shotPlan", ARRAY[\'shots\', ?]::text[], ("shotPlan" -> \'shots\' -> ?::int) || ?::jsonb, false)');
    expect(text).toContain("->> 'ord')::int = ?::int");
    expect(text).not.toContain('keyframe');
    expect(textWrites(prisma)).toEqual([{ idx: 1, patch: { keyframePrompt: 'still b, redrawn', prompt: 'clip b, slower' }, ord: 1 }]);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    // …and it is not mistaken for a keyframe write by the other decoder.
    expect(kfWrites(prisma)).toEqual([]);
  });

  it('guards the ORD at the index, not the index itself — a reordered plan is never written at the wrong beat', async () => {
    const prisma = db();
    await writeShotText({ prisma: prisma as never }, WS, CONCEPT, 0, 5, { prompt: 'x' });
    expect(textWrites(prisma)).toEqual([{ idx: 0, patch: { prompt: 'x' }, ord: 5 }]);
    // Every bound value, in order: path index, index, patch, id, workspace, index, ord.
    expect(prisma.$executeRaw.mock.calls[0].slice(1)).toEqual(['0', 0, '{"prompt":"x"}', CONCEPT, WS, 0, 5]);
  });

  it('a patch never carries a key the caller did not give, so the merge cannot blank a field', async () => {
    const prisma = db();
    await writeShotText({ prisma: prisma as never }, WS, CONCEPT, 0, 0, { prompt: 'only the motion' });
    expect(textWrites(prisma)[0].patch).toEqual({ prompt: 'only the motion' });
  });

  it('reports false when no row matched — the beat moved, or the concept is not ours', async () => {
    const prisma = db();
    prisma.$executeRaw.mockResolvedValueOnce(0);
    await expect(writeShotText({ prisma: prisma as never }, WS, CONCEPT, 0, 0, { description: 'x' })).resolves.toBe(false);
  });

  it('pins the ceiling one text may have', () => {
    expect(MAX_SHOT_TEXT).toBe(2000);
  });
});
