import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/Badge';
import { Progress } from '@/components/ui/Progress';
import { Skeleton } from '@/components/ui/Skeleton';
import { useCourses, useLeadEnrollments } from '../memberships/hooks';

export interface PersonCoursesProps {
  /** Whose enrolments. */
  leadId: string;
}

/**
 * `EĞİTİMLER` — the courses this person is enrolled in, and how far through
 * each one they are, as a section of their record card.
 *
 * `GET /enrollments?leadId=` has always accepted the filter, so this needed no
 * backend work — see `useLeadEnrollments`. What it does NOT return is the
 * course, only its id, so the titles come from `useCourses()`: the same
 * `['marketing','courses']` entry the courses page fills, which makes this a
 * cache hit for anyone who has been there and one small list read for anyone
 * who has not. Resolving the title client-side is cheaper than a new
 * `include` on a route four other callers share.
 *
 * Mounted only while its disclosure is open, so a rep clicking through a queue
 * never pays for either read.
 *
 * NO LINK to the course editor. The record card offers exactly one way off the
 * surface and a test counts them; enrolling and editing stay on the course
 * page, which is where somebody doing that work already is.
 */
export function PersonCourses({ leadId }: PersonCoursesProps) {
  const { t } = useTranslation('marketing');
  const { data: enrollments, isLoading } = useLeadEnrollments(leadId);
  const { data: courses } = useCourses();

  const title = (courseId: string) =>
    courses?.find((c) => c.id === courseId)?.title ??
    // The enrolment is real even when the course list has not arrived (or the
    // course was archived out of it) — say so rather than dropping the row.
    t('surface.courses.unknown', 'Eğitim');

  if (isLoading) return <Skeleton className="h-9 w-full" />;

  if ((enrollments ?? []).length === 0) {
    return (
      <p data-testid="person-courses-empty" className="text-[11px] text-muted-foreground">
        {t('surface.courses.empty', 'Bu kişi hiçbir eğitime kayıtlı değil.')}
      </p>
    );
  }

  return (
    <ul data-testid="person-courses" className="space-y-2">
      {(enrollments ?? []).map((e) => (
        <li key={e.id} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-foreground">{title(e.courseId)}</span>
            <span className="flex shrink-0 items-center gap-1.5">
              <Badge tone={e.status === 'COMPLETED' ? 'success' : 'neutral'} size="sm">
                {e.status === 'COMPLETED'
                  ? t('surface.courses.completed', 'Tamamlandı')
                  : t('surface.courses.active', 'Devam ediyor')}
              </Badge>
              <span className="text-[10px] text-muted-foreground">{e.progressPct}%</span>
            </span>
          </div>
          <Progress value={e.progressPct} />
        </li>
      ))}
    </ul>
  );
}
