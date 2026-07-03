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
