import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Pencil,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Rocket,
  FileVideo,
  GripVertical,
} from 'lucide-react';
import {
  PageHeader,
  Button,
  IconButton,
  Badge,
  Card,
  CardContent,
  Callout,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Skeleton,
  EmptyState,
  ConfirmDialog,
  Input,
  type BadgeProps,
} from '@/components/ui';
import { useCourse, useCourseMutations } from '../hooks';
import type { CourseModule, CourseStatus, CourseWithModules, Lesson } from '../types';
import { apiError, formatPrice, coursePriceCents } from '../util';
import { CourseFormDialog } from './CourseFormDialog';
import { LessonFormDialog } from './LessonFormDialog';
import { EnrolleesPanel } from './EnrolleesPanel';
import type { CourseFormValues, LessonFormValues } from '../schemas';

const STATUS_TONE: Record<CourseStatus, BadgeProps['tone']> = {
  DRAFT: 'neutral',
  PUBLISHED: 'success',
  ARCHIVED: 'warning',
};

export default function CourseEditorPage() {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const { id = '' } = useParams<{ id: string }>();
  const { data: course, isLoading } = useCourse(id);
  const m = useCourseMutations(id);

  const [editOpen, setEditOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!course) {
    return (
      <EmptyState
        title={t('memberships.courses.notFound', { defaultValue: 'Course not found' })}
        action={
          <Button variant="outline" onClick={() => navigate('/memberships/courses')}>
            {t('memberships.backToCourses', { defaultValue: 'Back to courses' })}
          </Button>
        }
      />
    );
  }

  const totalLessons = course.modules.reduce((acc, mod) => acc + mod.lessons.length, 0);
  const canPublish = totalLessons > 0 && course.status !== 'PUBLISHED';

  const handleEdit = (values: CourseFormValues) => {
    m.update.mutate(
      {
        id: course.id,
        data: {
          title: values.title,
          description: values.description ?? '',
          // A cleared price reverts the course to Free (priceCents null); a real
          // amount → cents. Omitting it left a paid course stuck at its old price.
          priceCents: coursePriceCents(values.price),
          ...(values.currency ? { currency: values.currency } : {}),
          coverImageUrl: values.coverImageUrl ?? '',
          ...(values.dripMode ? { dripMode: values.dripMode } : {}),
          certificateEnabled: values.certificateEnabled ?? false,
          // Only meaningful when enabled; send the template either way so clearing
          // a field persists.
          certificateTemplate: {
            title: values.certTitle || undefined,
            signature: values.certSignature || undefined,
            logoUrl: values.certLogoUrl || undefined,
          },
        },
      },
      {
        onSuccess: () => {
          setEditOpen(false);
          toast.success(t('memberships.courses.updated', { defaultValue: 'Course updated' }));
        },
        onError: (e) => toast.error(apiError(e, 'Failed to save')),
      },
    );
  };

  const handlePublish = () => {
    m.publish.mutate(course.id, {
      onSuccess: () => toast.success(t('memberships.courses.published', { defaultValue: 'Course published' })),
      // The backend throws BadRequest when 0 lessons; surface that message.
      onError: (e) =>
        toast.error(apiError(e, t('memberships.courses.publishGuard', { defaultValue: 'A course needs at least one lesson to publish' }))),
    });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={course.title}
        description={course.description ?? undefined}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => navigate('/memberships/courses')}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {t('memberships.back', { defaultValue: 'Back' })}
            </Button>
            <Button variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil className="h-4 w-4" aria-hidden="true" />
              {t('memberships.courses.editMeta', { defaultValue: 'Edit details' })}
            </Button>
            <PublishButton canPublish={canPublish} status={course.status} pending={m.publish.isPending} onPublish={handlePublish} />
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={STATUS_TONE[course.status] ?? 'neutral'}>
          {t(`memberships.courses.statuses.${course.status}`, { defaultValue: course.status })}
        </Badge>
        <Badge tone="info" size="sm">
          {t('memberships.courses.lessonCount', { defaultValue: '{{count}} lessons', count: totalLessons })}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {course.priceCents == null
            ? t('memberships.courses.free', { defaultValue: 'Free' })
            : formatPrice(course.priceCents, course.currency)}
        </span>
      </div>

      {totalLessons === 0 && (
        <Callout tone="warning" title={t('memberships.courses.publishGuardTitle', { defaultValue: 'Add a lesson to publish' })}>
          {t('memberships.courses.publishGuard', {
            defaultValue: 'A course needs at least one lesson to publish.',
          })}
        </Callout>
      )}

      <Tabs defaultValue="content">
        <TabsList>
          <TabsTrigger value="content">{t('memberships.tabs.content', { defaultValue: 'Content' })}</TabsTrigger>
          <TabsTrigger value="enrollees">{t('memberships.tabs.enrollees', { defaultValue: 'Enrollees' })}</TabsTrigger>
        </TabsList>
        <TabsContent value="content" className="pt-4">
          <ModulesEditor course={course} mutations={m} />
        </TabsContent>
        <TabsContent value="enrollees" className="pt-4">
          <EnrolleesPanel course={course} />
        </TabsContent>
      </Tabs>

      <CourseFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        course={course}
        onSubmit={handleEdit}
        isPending={m.update.isPending}
      />
    </div>
  );
}

function PublishButton({
  canPublish,
  status,
  pending,
  onPublish,
}: {
  canPublish: boolean;
  status: CourseStatus;
  pending: boolean;
  onPublish: () => void;
}) {
  const { t } = useTranslation('marketing');
  if (status === 'PUBLISHED') {
    return (
      <Button disabled variant="outline">
        <Rocket className="h-4 w-4" aria-hidden="true" />
        {t('memberships.courses.alreadyPublished', { defaultValue: 'Published' })}
      </Button>
    );
  }
  const btn = (
    <Button onClick={onPublish} disabled={!canPublish} loading={pending}>
      <Rocket className="h-4 w-4" aria-hidden="true" />
      {t('memberships.courses.publish', { defaultValue: 'Publish' })}
    </Button>
  );
  if (canPublish) return btn;
  // Wrap disabled button so the guard reason is discoverable.
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0}>{btn}</span>
        </TooltipTrigger>
        <TooltipContent>
          {t('memberships.courses.publishGuard', { defaultValue: 'A course needs at least one lesson to publish.' })}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type Mutations = ReturnType<typeof useCourseMutations>;

function ModulesEditor({ course, mutations }: { course: CourseWithModules; mutations: Mutations }) {
  const { t } = useTranslation('marketing');
  const [newModuleTitle, setNewModuleTitle] = useState('');
  const [editingModule, setEditingModule] = useState<CourseModule | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [deleteModule, setDeleteModule] = useState<CourseModule | null>(null);

  const [lessonDialog, setLessonDialog] = useState<{ moduleId: string; lesson: Lesson | null } | null>(null);
  const [deleteLesson, setDeleteLesson] = useState<Lesson | null>(null);

  const modules = course.modules;

  const addModule = () => {
    const title = newModuleTitle.trim();
    // Guard isPending here too: the Enter handler calls addModule() directly and
    // bypasses the button's disabled state, so Enter-spam would add the same
    // module twice before the first POST resolves.
    if (!title || mutations.addModule.isPending) return;
    mutations.addModule.mutate(
      { id: course.id, title },
      {
        onSuccess: () => {
          setNewModuleTitle('');
          toast.success(t('memberships.modules.added', { defaultValue: 'Module added' }));
        },
        onError: (e) => toast.error(apiError(e, 'Failed to add module')),
      },
    );
  };

  const saveModuleTitle = () => {
    if (!editingModule || !editTitle.trim() || mutations.updateModule.isPending) return;
    mutations.updateModule.mutate(
      { moduleId: editingModule.id, title: editTitle.trim() },
      {
        onSuccess: () => {
          setEditingModule(null);
          toast.success(t('memberships.modules.updated', { defaultValue: 'Module renamed' }));
        },
        onError: (e) => toast.error(apiError(e, 'Failed to rename')),
      },
    );
  };

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= modules.length) return;
    const ids = modules.map((mm) => mm.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    mutations.reorderModules.mutate(
      { id: course.id, ids },
      { onError: (e) => toast.error(apiError(e, 'Failed to reorder')) },
    );
  };

  const submitLesson = (values: LessonFormValues) => {
    if (!lessonDialog) return;
    const gating = values.gating ?? 'FREE';
    const payload = {
      title: values.title,
      type: values.type,
      ...(values.content ? { content: values.content } : {}),
      ...(values.videoUrl ? { videoUrl: values.videoUrl } : {}),
      ...(values.durationSec !== undefined ? { durationSec: Number(values.durationSec) } : {}),
      isPreview: values.isPreview ?? false,
      gating,
      // dripDays only matters for DRIP; clear it otherwise so a mode switch can't
      // leave a stale value behind.
      dripDays: gating === 'DRIP' && values.dripDays !== undefined ? Number(values.dripDays) : null,
    };
    if (lessonDialog.lesson) {
      mutations.updateLesson.mutate(
        { lessonId: lessonDialog.lesson.id, data: payload },
        {
          onSuccess: () => {
            setLessonDialog(null);
            toast.success(t('memberships.lessons.updated', { defaultValue: 'Lesson updated' }));
          },
          onError: (e) => toast.error(apiError(e, 'Failed to save lesson')),
        },
      );
    } else {
      mutations.addLesson.mutate(
        { moduleId: lessonDialog.moduleId, data: payload },
        {
          onSuccess: () => {
            setLessonDialog(null);
            toast.success(t('memberships.lessons.added', { defaultValue: 'Lesson added' }));
          },
          onError: (e) => toast.error(apiError(e, 'Failed to add lesson')),
        },
      );
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex items-end gap-2 p-3">
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="new-module">
              {t('memberships.modules.newLabel', { defaultValue: 'New module' })}
            </label>
            <Input
              id="new-module"
              value={newModuleTitle}
              onChange={(e) => setNewModuleTitle(e.target.value)}
              placeholder={t('memberships.modules.placeholder', { defaultValue: 'e.g. Getting started' })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addModule();
                }
              }}
            />
          </div>
          <Button onClick={addModule} loading={mutations.addModule.isPending} disabled={!newModuleTitle.trim()}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('memberships.modules.add', { defaultValue: 'Add module' })}
          </Button>
        </CardContent>
      </Card>

      {modules.length === 0 ? (
        <EmptyState
          icon={<FileVideo className="h-10 w-10" />}
          title={t('memberships.modules.empty', { defaultValue: 'No modules yet' })}
          description={t('memberships.modules.emptyHint', {
            defaultValue: 'Add a module, then add lessons inside it.',
          })}
        />
      ) : (
        <ul className="space-y-3">
          {modules.map((mod, i) => (
            <li key={mod.id} className="rounded-lg border border-border">
              <div className="flex items-center gap-2 border-b border-border bg-surface-muted/40 p-3">
                <GripVertical className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                {editingModule?.id === mod.id ? (
                  <div className="flex flex-1 items-center gap-2">
                    <Input
                      autoFocus
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          saveModuleTitle();
                        }
                        if (e.key === 'Escape') setEditingModule(null);
                      }}
                    />
                    <Button size="sm" onClick={saveModuleTitle} loading={mutations.updateModule.isPending}>
                      {t('common.save', { defaultValue: 'Save' })}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingModule(null)}>
                      {t('common.cancel', { defaultValue: 'Cancel' })}
                    </Button>
                  </div>
                ) : (
                  <>
                    <p className="flex-1 text-sm font-semibold text-foreground">{mod.title}</p>
                    <IconButton
                      size="sm"
                      variant="ghost"
                      aria-label={t('memberships.modules.moveUp', { defaultValue: 'Move up' })}
                      disabled={i === 0 || mutations.reorderModules.isPending}
                      onClick={() => move(i, -1)}
                    >
                      <ChevronUp className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      variant="ghost"
                      aria-label={t('memberships.modules.moveDown', { defaultValue: 'Move down' })}
                      disabled={i === modules.length - 1 || mutations.reorderModules.isPending}
                      onClick={() => move(i, 1)}
                    >
                      <ChevronDown className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      variant="ghost"
                      aria-label={t('common.edit', { defaultValue: 'Edit' })}
                      onClick={() => {
                        setEditingModule(mod);
                        setEditTitle(mod.title);
                      }}
                    >
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      variant="ghost"
                      aria-label={t('common.delete', { defaultValue: 'Delete' })}
                      onClick={() => setDeleteModule(mod)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                  </>
                )}
              </div>

              <ul>
                {mod.lessons.map((l) => (
                  <li key={l.id} className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0">
                    <Badge tone="neutral" size="sm">
                      {t(`memberships.lessons.types.${l.type}`, { defaultValue: l.type })}
                    </Badge>
                    <span className="flex-1 text-sm text-foreground">{l.title}</span>
                    {l.isPreview && (
                      <Badge tone="info" size="sm">
                        {t('memberships.lessons.preview', { defaultValue: 'Preview' })}
                      </Badge>
                    )}
                    <IconButton
                      size="sm"
                      variant="ghost"
                      aria-label={t('common.edit', { defaultValue: 'Edit' })}
                      onClick={() => setLessonDialog({ moduleId: mod.id, lesson: l })}
                    >
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      size="sm"
                      variant="ghost"
                      aria-label={t('common.delete', { defaultValue: 'Delete' })}
                      onClick={() => setDeleteLesson(l)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </IconButton>
                  </li>
                ))}
              </ul>

              <div className="p-3">
                <Button size="sm" variant="outline" onClick={() => setLessonDialog({ moduleId: mod.id, lesson: null })}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t('memberships.lessons.add', { defaultValue: 'Add lesson' })}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <LessonFormDialog
        open={!!lessonDialog}
        onOpenChange={(o) => {
          if (!o) setLessonDialog(null);
        }}
        lesson={lessonDialog?.lesson ?? null}
        onSubmit={submitLesson}
        isPending={mutations.addLesson.isPending || mutations.updateLesson.isPending}
      />

      <ConfirmDialog
        open={!!deleteModule}
        onOpenChange={(o) => {
          if (!o) setDeleteModule(null);
        }}
        title={t('memberships.modules.deleteTitle', { defaultValue: 'Delete module' })}
        description={t('memberships.modules.deleteDesc', {
          defaultValue: 'This removes the module and all of its lessons.',
        })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={mutations.removeModule.isPending}
        onConfirm={() =>
          deleteModule &&
          mutations.removeModule.mutate(deleteModule.id, {
            onSuccess: () => {
              setDeleteModule(null);
              toast.success(t('memberships.modules.deleted', { defaultValue: 'Module deleted' }));
            },
            onError: (e) => toast.error(apiError(e, 'Failed to delete module')),
          })
        }
      />

      <ConfirmDialog
        open={!!deleteLesson}
        onOpenChange={(o) => {
          if (!o) setDeleteLesson(null);
        }}
        title={t('memberships.lessons.deleteTitle', { defaultValue: 'Delete lesson' })}
        description={t('memberships.lessons.deleteDesc', { defaultValue: 'This permanently removes the lesson.' })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={mutations.removeLesson.isPending}
        onConfirm={() =>
          deleteLesson &&
          mutations.removeLesson.mutate(deleteLesson.id, {
            onSuccess: () => {
              setDeleteLesson(null);
              toast.success(t('memberships.lessons.deleted', { defaultValue: 'Lesson deleted' }));
            },
            onError: (e) => toast.error(apiError(e, 'Failed to delete lesson')),
          })
        }
      />
    </div>
  );
}
