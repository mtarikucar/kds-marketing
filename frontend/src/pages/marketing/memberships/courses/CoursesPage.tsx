import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Trash2, GraduationCap, Settings2, Archive, ArchiveRestore } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  PageHeader,
  Button,
  IconButton,
  Badge,
  DataTable,
  EmptyState,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  type BadgeProps,
} from '@/components/ui';
import { useCourses, useCourseMutations } from '../hooks';
import type { Course, CourseStatus } from '../types';
import { apiError, formatPrice, toCents } from '../util';
import { CourseFormDialog } from './CourseFormDialog';
import type { CourseFormValues } from '../schemas';

const STATUS_TONE: Record<CourseStatus, BadgeProps['tone']> = {
  DRAFT: 'neutral',
  PUBLISHED: 'success',
  ARCHIVED: 'warning',
};

export default function CoursesPage() {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const { data, isLoading } = useCourses();
  const { create, update, remove } = useCourseMutations();

  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Course | null>(null);

  const courses: Course[] = data ?? [];

  // Archive is the soft-delete: it retires a course from the catalog while
  // KEEPING its enrollments + issued certificates. Delete is refused by the API
  // once anyone has enrolled (it would cascade those records away), so archive
  // is the safe way to take an in-use course out of circulation.
  const setStatus = (c: Course, status: CourseStatus) =>
    update.mutate(
      { id: c.id, data: { status } },
      {
        onSuccess: () =>
          toast.success(
            status === 'ARCHIVED'
              ? t('memberships.courses.archived', { defaultValue: 'Course archived' })
              : t('memberships.courses.restored', { defaultValue: 'Course restored' }),
          ),
        onError: (e) =>
          toast.error(apiError(e, t('memberships.courses.statusError', { defaultValue: 'Failed to update course' }))),
      },
    );

  const handleCreate = (values: CourseFormValues) => {
    create.mutate(
      {
        title: values.title,
        ...(values.description ? { description: values.description } : {}),
        ...(values.price !== undefined ? { priceCents: toCents(Number(values.price)) } : {}),
        ...(values.currency ? { currency: values.currency } : {}),
        ...(values.coverImageUrl ? { coverImageUrl: values.coverImageUrl } : {}),
      },
      {
        onSuccess: (course) => {
          setFormOpen(false);
          toast.success(t('memberships.courses.created', { defaultValue: 'Course created' }));
          navigate(`/memberships/courses/${course.id}`);
        },
        onError: (e) =>
          toast.error(apiError(e, t('memberships.courses.saveError', { defaultValue: 'Failed to save course' }))),
      },
    );
  };

  const columns: ColumnDef<Course, unknown>[] = [
    {
      accessorKey: 'title',
      header: t('memberships.courses.titleLabel', { defaultValue: 'Title' }),
      cell: ({ row }) => {
        const c = row.original;
        return (
          <button
            type="button"
            className="text-left"
            onClick={() => navigate(`/memberships/courses/${c.id}`)}
          >
            <p className="text-sm font-medium text-foreground hover:text-primary">{c.title}</p>
            <code className="text-xs text-muted-foreground">{c.slug}</code>
          </button>
        );
      },
    },
    {
      accessorKey: 'status',
      header: t('memberships.courses.status', { defaultValue: 'Status' }),
      cell: ({ getValue }) => {
        const s = getValue<CourseStatus>();
        return (
          <Badge tone={STATUS_TONE[s] ?? 'neutral'} size="sm">
            {t(`memberships.courses.statuses.${s}`, { defaultValue: s })}
          </Badge>
        );
      },
    },
    {
      id: 'price',
      header: t('memberships.courses.price', { defaultValue: 'Price' }),
      cell: ({ row }) => (
        <span className="text-sm text-foreground">
          {row.original.priceCents == null
            ? t('memberships.courses.free', { defaultValue: 'Free' })
            : formatPrice(row.original.priceCents, row.original.currency)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: '',
      size: 48,
      cell: ({ row }) => {
        const c = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton aria-label={t('common.actions', { defaultValue: 'Actions' })} size="sm" variant="ghost">
                <span className="text-lg leading-none" aria-hidden="true">⋯</span>
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => navigate(`/memberships/courses/${c.id}`)}>
                <Settings2 className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('memberships.courses.edit', { defaultValue: 'Edit content' })}
              </DropdownMenuItem>
              {c.status === 'ARCHIVED' ? (
                <DropdownMenuItem onClick={() => setStatus(c, 'DRAFT')}>
                  <ArchiveRestore className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('memberships.courses.restore', { defaultValue: 'Restore' })}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => setStatus(c, 'ARCHIVED')}>
                  <Archive className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('memberships.courses.archive', { defaultValue: 'Archive' })}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem className="text-danger focus:text-danger" onClick={() => setDeleteTarget(c)}>
                <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('common.delete', { defaultValue: 'Delete' })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('memberships.courses.title', { defaultValue: 'Courses' })}
        description={t('memberships.courses.subtitle', {
          defaultValue: 'Author courses with modules and lessons, then publish to enroll members.',
        })}
        actions={
          <Button onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('memberships.courses.createTitle', { defaultValue: 'New course' })}
          </Button>
        }
      />

      <DataTable
        columns={columns}
        data={courses}
        isLoading={isLoading}
        loadingRowCount={5}
        emptyState={
          <EmptyState
            icon={<GraduationCap className="h-10 w-10" />}
            title={t('memberships.courses.empty', { defaultValue: 'No courses yet' })}
            description={t('memberships.courses.emptyHint', {
              defaultValue: 'Create your first course to start building modules and lessons.',
            })}
            action={
              <Button onClick={() => setFormOpen(true)} variant="outline">
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('memberships.courses.createTitle', { defaultValue: 'New course' })}
              </Button>
            }
          />
        }
      />

      <CourseFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        course={null}
        onSubmit={handleCreate}
        isPending={create.isPending}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title={t('memberships.courses.deleteTitle', { defaultValue: 'Delete course' })}
        description={t('memberships.courses.deleteDesc', {
          defaultValue:
            'This permanently removes the course with its modules and lessons. A course that already has enrollments cannot be deleted — archive it instead to keep student progress and issued certificates.',
        })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() =>
          deleteTarget &&
          remove.mutate(deleteTarget.id, {
            onSuccess: () => {
              setDeleteTarget(null);
              toast.success(t('memberships.courses.deleted', { defaultValue: 'Course deleted' }));
            },
            onError: (e) => toast.error(apiError(e, 'Failed to delete')),
          })
        }
      />
    </div>
  );
}
