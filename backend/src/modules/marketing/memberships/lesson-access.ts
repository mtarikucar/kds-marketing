/**
 * Epic 10a — lesson drip / gating. Pure access resolution shared by the progress
 * view (compute per-lesson lock state) and the complete-lesson guard (reject a
 * write to a locked lesson). No DB access here; callers pass the ordered lesson
 * list, the set of completed lesson ids, and the enrolledAt instant.
 */

export type Gating = 'FREE' | 'SEQUENTIAL' | 'DRIP';

export interface AccessLesson {
  id: string;
  position?: number;
  isPreview: boolean;
  gating: string | null;
  dripDays: number | null;
}

export interface LessonAccess {
  locked: boolean;
  /** When the lock lifts on its own (DRIP). null for FREE / SEQUENTIAL. */
  unlockAt: Date | null;
  /** Why it's locked (for the UI). null when open. */
  reason: 'SEQUENTIAL' | 'DRIP' | null;
}

const DAY_MS = 86_400_000;

/**
 * Effective gating for a lesson: its own gating wins unless that is FREE, in
 * which case the course default (dripMode) applies. Unknown values collapse to
 * FREE so a bad string can never lock content shut.
 */
export function effectiveGating(lessonGating: string | null, courseDripMode: string | null): Gating {
  const own = (lessonGating ?? 'FREE').toUpperCase();
  if (own === 'SEQUENTIAL' || own === 'DRIP') return own;
  const course = (courseDripMode ?? 'FREE').toUpperCase();
  return course === 'SEQUENTIAL' || course === 'DRIP' ? (course as Gating) : 'FREE';
}

/**
 * Resolve whether `lesson` is accessible. `ordered` is the course's lessons in
 * play order (module.position, then lesson.position); `completed` is the set of
 * completed lesson ids; `enrolledAt` anchors DRIP; `now` is injectable for tests.
 */
export function resolveLessonAccess(
  lesson: AccessLesson,
  ordered: AccessLesson[],
  completed: Set<string>,
  courseDripMode: string | null,
  enrolledAt: Date,
  now: Date = new Date(),
): LessonAccess {
  // A preview lesson is always open — it's the marketing teaser.
  if (lesson.isPreview) return { locked: false, unlockAt: null, reason: null };

  const mode = effectiveGating(lesson.gating, courseDripMode);
  if (mode === 'FREE') return { locked: false, unlockAt: null, reason: null };

  if (mode === 'DRIP') {
    const days = Math.max(0, lesson.dripDays ?? 0);
    const unlockAt = new Date(enrolledAt.getTime() + days * DAY_MS);
    return { locked: now.getTime() < unlockAt.getTime(), unlockAt, reason: 'DRIP' };
  }

  // SEQUENTIAL: locked until the immediately-prior lesson in course order is done.
  const idx = ordered.findIndex((l) => l.id === lesson.id);
  const prev = idx > 0 ? ordered[idx - 1] : null;
  const locked = prev ? !completed.has(prev.id) : false;
  return { locked, unlockAt: null, reason: locked ? 'SEQUENTIAL' : null };
}
