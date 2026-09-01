import { VideoPipelineService } from './video-pipeline.service';

const svc = new VideoPipelineService();

describe('VideoPipelineService.planShots', () => {
  it('produces a 4-shot hook->demo->proof->CTA plan scaled to duration', () => {
    const plan = svc.planShots({ product: 'implants', durationSec: 30, offer: '0% interest' });
    expect(plan.shots).toHaveLength(4);
    expect(plan.shots[0].scene).toMatch(/Hook/);
    expect(plan.shots[3].scene).toMatch(/CTA/);
    expect(plan.durationSec).toBe(30);
    expect(plan.shots.every((s) => s.durationSec >= 2)).toBe(true);
    expect(plan.captionSuggestion).toContain('0% interest');
  });

  it('threads persona reference + seed into EVERY shot for identity-lock', () => {
    const plan = svc.planShots(
      { product: 'implants' },
      'seedance',
      { name: 'Dr. Aylin', referenceImageUrls: ['r1.png', 'r2.png'], lockedSeed: 42 },
    );
    expect(plan.shots.every((s) => s.reference?.images.length === 2 && s.reference?.seed === 42)).toBe(true);
    // identity phrasing appears in the model prompt
    expect(plan.shots[0].prompt).toMatch(/consistent identity/);
    expect(plan.shots[0].prompt).toMatch(/seed 42/);
    // QC checklist gains a persona-consistency item first
    expect(plan.qcChecklist[0]).toMatch(/Dr\. Aylin.*identity consistent/);
  });

  it('omits identity phrasing + reference when no persona', () => {
    const plan = svc.planShots({ product: 'implants' });
    expect(plan.shots.every((s) => s.reference === undefined)).toBe(true);
    expect(plan.shots[0].prompt).not.toMatch(/consistent identity/);
  });

  it('formats prompts per model', () => {
    expect(svc.buildModelPrompt('seedance', 'a scene')).toMatch(/reference-to-video/);
    expect(svc.buildModelPrompt('veo', 'a scene')).toMatch(/photorealistic/);
    expect(svc.buildModelPrompt('kling', 'a scene')).toMatch(/1080p/);
    expect(svc.buildModelPrompt('higgsfield', 'a scene')).toMatch(/Marketing Studio/);
    expect(svc.buildModelPrompt('seedance', 'a scene')).toMatch(/9:16/);
  });
});

/**
 * The concept seam (içerik üretim hattı, aşama 1).
 *
 * `planShots`'s built-in SCENES list is a fixed hook→demo→proof→CTA template:
 * for one product it returns the SAME four scenes every time. That is right for
 * a UGC ad and useless for "five genuinely different angles on one idea" — five
 * calls would produce five identical structures with the product name swapped.
 *
 * So the scene LIST becomes an argument. Everything the service already does —
 * per-model prompt formatting, persona identity-lock threaded into every shot,
 * caption, QC checklist — keeps applying, which is why this is an extension and
 * not a second planner.
 */
describe('VideoPipelineService.planShots — caller-supplied concept scenes', () => {
  const scenes = [
    {
      scene: '0-2s',
      cameraNote: 'wide, tracking',
      onScreenText: 'Bunun motoru yok.',
      voiceover: '',
      description: 'a Strandbeest walking across wet sand',
      durationSec: 2,
    },
    {
      scene: '2-5s',
      cameraNote: 'push in on the fan',
      onScreenText: 'Pili de yok.',
      voiceover: 'Hiçbir elektrik yok.',
      description: 'the wind fan spins and the linkage takes up the load',
      durationSec: 3,
    },
    {
      scene: '5-9s',
      cameraNote: 'macro on the leg linkage',
      onScreenText: 'Sadece geometri.',
      voiceover: 'Sadece geometri.',
      description: 'close-up of the eleven-bar leg linkage articulating',
      durationSec: 4,
    },
  ];

  it('builds the plan from the supplied scenes, honouring each shot own length', () => {
    const plan = svc.planShots({ product: 'Strandbeest' }, 'seedance', undefined, scenes);

    expect(plan.shots).toHaveLength(3);
    expect(plan.shots.map((s) => s.scene)).toEqual(['0-2s', '2-5s', '5-9s']);
    expect(plan.shots.map((s) => s.durationSec)).toEqual([2, 3, 4]);
    // The plan's duration is what the shots actually add up to, not the brief's
    // even-split default — a 2/3/4 concept is 9 seconds, not 3x5.
    expect(plan.durationSec).toBe(9);
    expect(plan.shots.map((s) => s.ord)).toEqual([0, 1, 2]);
  });

  it('carries on-screen text SEPARATELY from voiceover', () => {
    // The owner's own example is text-on-screen over a silent shot: shot 0 has
    // words the viewer READS and nothing to hear. Folding the two into one
    // field loses exactly that.
    const plan = svc.planShots({ product: 'Strandbeest' }, 'seedance', undefined, scenes);

    expect(plan.shots[0].onScreenText).toBe('Bunun motoru yok.');
    expect(plan.shots[0].voiceover).toBe('');
    expect(plan.shots[1].onScreenText).toBe('Pili de yok.');
    expect(plan.shots[1].voiceover).toBe('Hiçbir elektrik yok.');
    expect(plan.shots[1].onScreenText).not.toBe(plan.shots[1].voiceover);
  });

  it('still formats the prompt per model and threads the persona lock', () => {
    const plan = svc.planShots({ product: 'Strandbeest' }, 'veo', {
      name: 'Kaan',
      referenceImageUrls: ['r1.png'],
      lockedSeed: 7,
    }, scenes);

    expect(plan.shots.every((s) => s.reference?.images.length === 1 && s.reference?.seed === 7)).toBe(true);
    expect(plan.shots[0].prompt).toMatch(/consistent identity/);
    expect(plan.shots[0].prompt).toMatch(/seed 7/);
    // The scene's own description reaches the prompt, and the model formatting
    // the service already owns is applied on top of it.
    expect(plan.shots[0].prompt).toContain('a Strandbeest walking across wet sand');
    expect(plan.shots[0].prompt).toMatch(/photorealistic/);
    expect(plan.qcChecklist[0]).toMatch(/Kaan.*identity consistent/);
  });

  it('falls back to the even split for a scene that declares no length', () => {
    const plan = svc.planShots({ product: 'x', durationSec: 30 }, 'seedance', undefined, [
      { scene: 'a', cameraNote: 'c', voiceover: 'v', description: 'd' },
      { scene: 'b', cameraNote: 'c', voiceover: 'v', description: 'd', durationSec: 6 },
    ]);
    expect(plan.shots.map((s) => s.durationSec)).toEqual([15, 6]);
    expect(plan.durationSec).toBe(21);
  });

  it('REFUSES an empty scene list instead of silently returning the ad template', () => {
    // Error is not emptiness. A caller that produced no scenes has failed; if
    // this quietly fell back to SCENES it would hand back a generic
    // hook/demo/proof/CTA ad and call it the user's concept.
    expect(() => svc.planShots({ product: 'x' }, 'seedance', undefined, [])).toThrow(
      /at least one scene/i,
    );
  });

  it('leaves the built-in template untouched when no scenes are supplied', () => {
    const plan = svc.planShots({ product: 'implants', durationSec: 30 });
    expect(plan.shots).toHaveLength(4);
    expect(plan.durationSec).toBe(30);
    expect(plan.shots[0].onScreenText).toBeUndefined();
  });
});
