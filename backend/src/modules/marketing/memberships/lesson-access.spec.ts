import { resolveLessonAccess, effectiveGating, AccessLesson } from './lesson-access';

const L = (id: string, over: Partial<AccessLesson> = {}): AccessLesson => ({
  id,
  isPreview: false,
  gating: 'FREE',
  dripDays: null,
  ...over,
});

const ENROLLED = new Date('2026-06-01T00:00:00Z');

describe('effectiveGating', () => {
  it('lesson gating wins when it is not FREE', () => {
    expect(effectiveGating('DRIP', 'SEQUENTIAL')).toBe('DRIP');
    expect(effectiveGating('SEQUENTIAL', null)).toBe('SEQUENTIAL');
  });
  it('falls back to the course dripMode when the lesson is FREE', () => {
    expect(effectiveGating('FREE', 'SEQUENTIAL')).toBe('SEQUENTIAL');
    expect(effectiveGating(null, 'DRIP')).toBe('DRIP');
  });
  it('collapses unknown / missing values to FREE (never locks shut on bad data)', () => {
    expect(effectiveGating('weird', 'nonsense')).toBe('FREE');
    expect(effectiveGating(null, null)).toBe('FREE');
  });
});

describe('resolveLessonAccess', () => {
  it('FREE is always open', () => {
    const l = L('a');
    expect(resolveLessonAccess(l, [l], new Set(), null, ENROLLED).locked).toBe(false);
  });

  it('preview bypasses gating even under a gated course', () => {
    const l = L('a', { isPreview: true, gating: 'SEQUENTIAL' });
    const prev = L('z');
    const access = resolveLessonAccess(l, [prev, l], new Set(), 'SEQUENTIAL', ENROLLED);
    expect(access.locked).toBe(false);
  });

  describe('SEQUENTIAL', () => {
    const a = L('a', { gating: 'SEQUENTIAL' });
    const b = L('b', { gating: 'SEQUENTIAL' });
    const ordered = [a, b];

    it('first lesson is open (no prior)', () => {
      expect(resolveLessonAccess(a, ordered, new Set(), null, ENROLLED).locked).toBe(false);
    });
    it('locks until the immediately-prior lesson is completed', () => {
      const locked = resolveLessonAccess(b, ordered, new Set(), null, ENROLLED);
      expect(locked.locked).toBe(true);
      expect(locked.reason).toBe('SEQUENTIAL');
      const open = resolveLessonAccess(b, ordered, new Set(['a']), null, ENROLLED);
      expect(open.locked).toBe(false);
    });
    it('applies via the course dripMode default when the lesson itself is FREE', () => {
      const x = L('x'); // FREE lesson
      const y = L('y');
      const seqOrdered = [x, y];
      const locked = resolveLessonAccess(y, seqOrdered, new Set(), 'SEQUENTIAL', ENROLLED);
      expect(locked.locked).toBe(true);
    });
  });

  describe('DRIP', () => {
    const l = L('a', { gating: 'DRIP', dripDays: 7 });
    it('locks before the drip window elapses and reports the unlock instant', () => {
      const now = new Date('2026-06-05T00:00:00Z'); // 4 days in
      const access = resolveLessonAccess(l, [l], new Set(), null, ENROLLED, now);
      expect(access.locked).toBe(true);
      expect(access.reason).toBe('DRIP');
      expect(access.unlockAt?.toISOString()).toBe('2026-06-08T00:00:00.000Z');
    });
    it('opens once the window has elapsed', () => {
      const now = new Date('2026-06-08T00:00:01Z');
      expect(resolveLessonAccess(l, [l], new Set(), null, ENROLLED, now).locked).toBe(false);
    });
    it('a null/zero dripDays unlocks immediately', () => {
      const z = L('z', { gating: 'DRIP', dripDays: null });
      expect(resolveLessonAccess(z, [z], new Set(), null, ENROLLED, ENROLLED).locked).toBe(false);
    });
  });
});
