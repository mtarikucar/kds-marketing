import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Database, Archive, ChevronRight, RotateCcw } from 'lucide-react';
import {
  listObjects,
  createObject,
  archiveObject,
  restoreObject,
  type CustomObjectDef,
} from '../../../features/marketing/api/custom-objects.service';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { ObjectFormDialog, type ObjectFormValues } from './ObjectFormDialog';
import {
  PageHeader,
  Button,
  IconButton,
  Badge,
  Card,
  EmptyState,
  Skeleton,
  ConfirmDialog,
} from '@/components/ui';

function apiError(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
  return Array.isArray(msg) ? msg[0] : (msg ?? fallback);
}

export default function CustomObjectsPage() {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useMarketingAuthStore((s) => s.user);
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  const [formOpen, setFormOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<CustomObjectDef | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['marketing', 'custom-objects', { showArchived }],
    queryFn: () => listObjects(showArchived),
  });
  const objects: CustomObjectDef[] = Array.isArray(data) ? data : [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'custom-objects'] });

  const createMutation = useMutation({
    mutationFn: (values: ObjectFormValues) =>
      createObject({
        key: values.key,
        labelSingular: values.labelSingular,
        labelPlural: values.labelPlural,
        primaryField: values.primaryField,
        description: values.description,
      }),
    onSuccess: (obj) => {
      invalidate();
      setFormOpen(false);
      toast.success(t('customObjects.toast.created', { defaultValue: 'Custom object created' }));
      navigate(`/custom-objects/${obj.key}`);
    },
    onError: (e) => toast.error(apiError(e, t('customObjects.toast.createFailed', { defaultValue: 'Failed to create object' }))),
  });

  const archiveMutation = useMutation({
    mutationFn: (key: string) => archiveObject(key),
    onSuccess: () => {
      invalidate();
      setArchiveTarget(null);
      toast.success(t('customObjects.toast.archived', { defaultValue: 'Object archived' }));
    },
    onError: (e) => toast.error(apiError(e, t('customObjects.toast.archiveFailed', { defaultValue: 'Failed to archive' }))),
  });

  const restoreMutation = useMutation({
    mutationFn: (key: string) => restoreObject(key),
    onSuccess: () => {
      invalidate();
      toast.success(t('customObjects.toast.restored', { defaultValue: 'Object restored' }));
    },
    onError: (e) => toast.error(apiError(e, t('customObjects.toast.restoreFailed', { defaultValue: 'Failed to restore' }))),
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('customObjects.title', { defaultValue: 'Custom Objects' })}
        description={t('customObjects.subtitle', {
          defaultValue: 'Define your own record types beyond Contacts — properties, vehicles, policies, anything.',
        })}
        actions={
          isManager ? (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => setShowArchived((v) => !v)}
                aria-pressed={showArchived}
              >
                <Archive className="h-4 w-4" aria-hidden="true" />
                {showArchived
                  ? t('customObjects.hideArchived', { defaultValue: 'Hide archived' })
                  : t('customObjects.showArchived', { defaultValue: 'Show archived' })}
              </Button>
              <Button onClick={() => setFormOpen(true)}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('customObjects.new', { defaultValue: 'New object' })}
              </Button>
            </div>
          ) : undefined
        }
      />

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : objects.length === 0 ? (
        <EmptyState
          icon={<Database className="h-10 w-10" />}
          title={t('customObjects.empty.title', { defaultValue: 'No custom objects yet' })}
          description={t('customObjects.empty.description', {
            defaultValue: 'Create your first custom object to model records specific to your business.',
          })}
          action={
            isManager ? (
              <Button onClick={() => setFormOpen(true)} variant="outline">
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('customObjects.new', { defaultValue: 'New object' })}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {objects.map((obj) => (
            <Card
              key={obj.id}
              className="flex cursor-pointer items-start gap-3 p-4 transition-colors hover:bg-surface-muted"
              onClick={() => navigate(`/custom-objects/${obj.key}`)}
            >
              <span className="rounded-lg bg-surface-muted p-2 text-muted-foreground" aria-hidden="true">
                <Database className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="truncate text-sm font-medium text-foreground">{obj.labelPlural}</p>
                  {obj.archived && (
                    <Badge tone="neutral" size="sm">
                      {t('customObjects.archivedBadge', { defaultValue: 'Archived' })}
                    </Badge>
                  )}
                </div>
                <p className="truncate font-mono text-micro text-muted-foreground">{obj.key}</p>
                {obj.description && (
                  <p className="mt-1 line-clamp-2 text-micro text-muted-foreground">{obj.description}</p>
                )}
              </div>
              {isManager && (obj.archived ? (
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label={t('customObjects.action.restore', { defaultValue: 'Restore' })}
                  disabled={restoreMutation.isPending && restoreMutation.variables === obj.key}
                  onClick={(e) => {
                    e.stopPropagation();
                    restoreMutation.mutate(obj.key);
                  }}
                >
                  <RotateCcw className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              ) : (
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label={t('customObjects.action.archive', { defaultValue: 'Archive' })}
                  onClick={(e) => {
                    e.stopPropagation();
                    setArchiveTarget(obj);
                  }}
                >
                  <Archive className="h-4 w-4" aria-hidden="true" />
                </IconButton>
              ))}
              <ChevronRight className="h-4 w-4 self-center text-muted-foreground" aria-hidden="true" />
            </Card>
          ))}
        </div>
      )}

      <ObjectFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        object={null}
        onSubmit={(values) => createMutation.mutate(values)}
        isPending={createMutation.isPending}
      />

      <ConfirmDialog
        open={!!archiveTarget}
        onOpenChange={(open) => { if (!open) setArchiveTarget(null); }}
        title={t('customObjects.confirm.archiveTitle', { defaultValue: 'Archive custom object' })}
        description={t('customObjects.confirm.archiveBody', {
          defaultValue: 'The object is hidden from the list. Its records are kept and can be restored later.',
        })}
        confirmLabel={t('customObjects.action.archive', { defaultValue: 'Archive' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        onConfirm={() => archiveTarget && archiveMutation.mutate(archiveTarget.key)}
        loading={archiveMutation.isPending}
      />
    </div>
  );
}
