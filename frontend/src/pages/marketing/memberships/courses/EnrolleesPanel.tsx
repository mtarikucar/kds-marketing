import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { UserPlus, Trash2, CheckCircle2, Circle, BookOpen, Award, Lock } from 'lucide-react';
import marketingApi from '../../../../features/marketing/api/marketingApi';
import type { Certificate } from '../types';
import {
  Card,
  CardContent,
  Button,
  IconButton,
  Badge,
  Progress,
  EmptyState,
  Skeleton,
  ConfirmDialog,
} from '@/components/ui';
import {
  useEnrollments,
  useEnrollmentMutations,
  useEnrollmentProgress,
} from '../hooks';
import type { CourseWithModules, Enrollment } from '../types';
import { apiError } from '../util';
import { EnrollDialog } from './EnrollDialog';

interface Props {
  course: CourseWithModules;
}

/**
 * Enrollees per course + their progress %, plus an inline learner view that
 * renders modules/lessons with mark-complete (POST /enrollments/:id/complete-lesson)
 * and surfaces the backend-recomputed progress.
 */
export function EnrolleesPanel({ course }: Props) {
  const { t } = useTranslation('marketing');
  const { data: enrollments, isLoading } = useEnrollments(course.id);
  const { enroll, unenroll } = useEnrollmentMutations(course.id);

  const [enrollOpen, setEnrollOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Enrollment | null>(null);
  const [openLearner, setOpenLearner] = useState<string | null>(null);

  const rows = enrollments ?? [];

  const handleEnroll = (leadId: string) => {
    enroll.mutate(
      { courseId: course.id, leadId },
      {
        onSuccess: () => {
          setEnrollOpen(false);
          toast.success(t('memberships.enroll.enrolled', { defaultValue: 'Member enrolled' }));
        },
        onError: (e) => toast.error(apiError(e, 'Failed to enroll')),
      },
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('memberships.enrollees.count', {
            defaultValue: '{{count}} enrolled',
            count: rows.length,
          })}
        </p>
        <Button size="sm" onClick={() => setEnrollOpen(true)}>
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          {t('memberships.enrollees.add', { defaultValue: 'Enroll member' })}
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="h-10 w-10" />}
          title={t('memberships.enrollees.empty', { defaultValue: 'No enrollees yet' })}
          description={t('memberships.enrollees.emptyHint', {
            defaultValue: 'Enroll a lead to start tracking their progress.',
          })}
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((e) => (
            <li key={e.id} className="rounded-lg border border-border">
              <div className="flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <code className="truncate text-xs text-muted-foreground">{e.leadId}</code>
                    <Badge tone={e.status === 'COMPLETED' ? 'success' : 'info'} size="sm">
                      {t(`memberships.enrollees.statuses.${e.status}`, { defaultValue: e.status })}
                    </Badge>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <Progress value={e.progressPct} tone={e.progressPct >= 100 ? 'success' : 'primary'} className="flex-1" />
                    <span className="w-10 text-right text-xs font-medium text-foreground">{e.progressPct}%</span>
                  </div>
                </div>
                {e.status === 'COMPLETED' && <CertificateButton enrollmentId={e.id} />}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setOpenLearner(openLearner === e.id ? null : e.id)}
                >
                  {openLearner === e.id
                    ? t('memberships.enrollees.hide', { defaultValue: 'Hide' })
                    : t('memberships.enrollees.view', { defaultValue: 'View lessons' })}
                </Button>
                <IconButton
                  size="sm"
                  variant="ghost"
                  aria-label={t('memberships.enrollees.remove', { defaultValue: 'Remove enrollee' })}
                  onClick={() => setRemoveTarget(e)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              </div>
              {openLearner === e.id && <LearnerView enrollmentId={e.id} course={course} />}
            </li>
          ))}
        </ul>
      )}

      <EnrollDialog
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        onConfirm={handleEnroll}
        isPending={enroll.isPending}
      />

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(o) => {
          if (!o) setRemoveTarget(null);
        }}
        title={t('memberships.enrollees.removeTitle', { defaultValue: 'Remove enrollee' })}
        description={t('memberships.enrollees.removeDesc', {
          defaultValue: 'This removes the enrollment and its lesson progress.',
        })}
        confirmLabel={t('memberships.enrollees.remove', { defaultValue: 'Remove' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={unenroll.isPending}
        onConfirm={() =>
          removeTarget &&
          unenroll.mutate(removeTarget.id, {
            onSuccess: () => {
              setRemoveTarget(null);
              toast.success(t('memberships.enrollees.removed', { defaultValue: 'Enrollee removed' }));
            },
            onError: (err) => toast.error(apiError(err, 'Failed to remove')),
          })
        }
      />
    </div>
  );
}

/**
 * Opens the public certificate page (print-to-PDF) for a completed enrollment.
 * Fetches the certificate on click so the list doesn't N+1 on every row.
 */
function CertificateButton({ enrollmentId }: { enrollmentId: string }) {
  const { t } = useTranslation('marketing');
  const [loading, setLoading] = useState(false);
  const open = async () => {
    setLoading(true);
    try {
      const cert = await marketingApi
        .get<Certificate | null>(`/enrollments/${enrollmentId}/certificate`)
        .then((r) => r.data);
      if (cert?.serial) {
        window.open(`${window.location.origin}/api/public/certificates/${cert.serial}`, '_blank', 'noopener');
      } else {
        toast.info(t('memberships.certificate.none', { defaultValue: 'No certificate for this course.' }));
      }
    } catch (e) {
      toast.error(apiError(e, 'Failed to load certificate'));
    } finally {
      setLoading(false);
    }
  };
  return (
    <Button size="sm" variant="outline" loading={loading} onClick={open}>
      <Award className="h-4 w-4" aria-hidden="true" />
      {t('memberships.certificate.view', { defaultValue: 'Certificate' })}
    </Button>
  );
}

interface LearnerViewProps {
  enrollmentId: string;
  course: CourseWithModules;
}

/** Per-enrollment lesson checklist — mark-complete drives the recomputed %. */
function LearnerView({ enrollmentId, course }: LearnerViewProps) {
  const { t } = useTranslation('marketing');
  const { data, isLoading } = useEnrollmentProgress(enrollmentId);
  const { completeLesson } = useEnrollmentMutations(course.id);

  const completedIds = new Set((data?.progress ?? []).filter((p) => p.completed).map((p) => p.lessonId));
  // Epic 10a: per-lesson lock state for the member view.
  const lockById = new Map((data?.lessons ?? []).map((l) => [l.lessonId, l]));

  if (isLoading) {
    return (
      <div className="border-t border-border p-3">
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-3 border-t border-border bg-surface-muted/40 p-3">
      {data && (
        <div className="flex items-center gap-2">
          <Progress value={data.progressPct} tone={data.progressPct >= 100 ? 'success' : 'primary'} className="flex-1" />
          <span className="w-10 text-right text-xs font-medium text-foreground">{data.progressPct}%</span>
        </div>
      )}
      {course.modules.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('memberships.learner.noLessons', { defaultValue: 'This course has no lessons yet.' })}
        </p>
      ) : (
        <Card>
          <CardContent className="p-0">
            {course.modules.map((m) => (
              <div key={m.id} className="border-b border-border last:border-b-0">
                <p className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{m.title}</p>
                <ul>
                  {m.lessons.map((l) => {
                    const done = completedIds.has(l.id);
                    const access = lockById.get(l.id);
                    const locked = !done && !!access?.locked;
                    const unlockAt = access?.unlockAt ? new Date(access.unlockAt) : null;
                    return (
                      <li key={l.id} className="flex items-center justify-between gap-2 px-3 py-2">
                        <span className="flex items-center gap-2 text-sm text-foreground">
                          {done ? (
                            <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
                          ) : locked ? (
                            <Lock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                          ) : (
                            <Circle className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                          )}
                          <span className={locked ? 'text-muted-foreground' : undefined}>{l.title}</span>
                          {locked && (
                            <span className="text-[11px] text-muted-foreground">
                              {access?.lockReason === 'DRIP' && unlockAt
                                ? t('memberships.learner.unlocksOn', { defaultValue: 'unlocks {{date}}', date: unlockAt.toLocaleDateString() })
                                : t('memberships.learner.lockedPrev', { defaultValue: 'finish the previous lesson' })}
                            </span>
                          )}
                        </span>
                        <Button
                          size="sm"
                          variant={done ? 'ghost' : 'outline'}
                          disabled={done || locked || (completeLesson.isPending && completeLesson.variables?.lessonId === l.id)}
                          onClick={() =>
                            completeLesson.mutate(
                              { id: enrollmentId, lessonId: l.id },
                              {
                                onError: (e) => toast.error(apiError(e, 'Failed to mark complete')),
                              },
                            )
                          }
                        >
                          {done
                            ? t('memberships.learner.completed', { defaultValue: 'Completed' })
                            : locked
                              ? t('memberships.learner.locked', { defaultValue: 'Locked' })
                              : t('memberships.learner.markComplete', { defaultValue: 'Mark complete' })}
                        </Button>
                      </li>
                    );
                  })}
                  {m.lessons.length === 0 && (
                    <li className="px-3 py-2 text-xs text-muted-foreground">
                      {t('memberships.learner.moduleEmpty', { defaultValue: 'No lessons in this module.' })}
                    </li>
                  )}
                </ul>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
