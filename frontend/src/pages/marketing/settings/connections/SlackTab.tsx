import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Send, Power, Slack as SlackIcon } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
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
} from '@/components/ui';
import { useSlackIntegrations, useSlackMutations } from './hooks';
import {
  SLACK_EVENT_LABELS,
  type SlackEvent,
  type SlackIntegration,
} from './types';
import { SlackFormDialog, type SlackSubmitPayload } from './SlackFormDialog';
import { apiError } from './util';

export function SlackTab() {
  const { t } = useTranslation('marketing');
  const { data, isLoading } = useSlackIntegrations();
  const { create, update, remove, test } = useSlackMutations();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<SlackIntegration | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SlackIntegration | null>(null);

  const integrations: SlackIntegration[] = data ?? [];

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (i: SlackIntegration) => {
    setEditing(i);
    setFormOpen(true);
  };

  const handleSubmit = (payload: SlackSubmitPayload) => {
    if (editing) {
      update.mutate(
        { id: editing.id, data: { ...payload } },
        {
          onSuccess: () => {
            setFormOpen(false);
            setEditing(null);
            toast.success(t('connections.slack.updated', { defaultValue: 'Slack integration updated' }));
          },
          onError: (e) =>
            toast.error(apiError(e, t('connections.slack.saveError', { defaultValue: 'Failed to save Slack integration' }))),
        },
      );
    } else {
      create.mutate({ ...payload }, {
        onSuccess: () => {
          setFormOpen(false);
          toast.success(t('connections.slack.created', { defaultValue: 'Slack integration created' }));
        },
        onError: (e) =>
          toast.error(apiError(e, t('connections.slack.saveError', { defaultValue: 'Failed to save Slack integration' }))),
      });
    }
  };

  const runTest = (i: SlackIntegration) => {
    test.mutate(i.id, {
      onSuccess: (res) =>
        res.ok
          ? toast.success(t('connections.slack.testSent', { defaultValue: 'Test message sent' }))
          : toast.error(t('connections.slack.testFailed', { defaultValue: 'Slack rejected the test message' })),
      onError: (e) => toast.error(apiError(e, t('connections.slack.testFailed', { defaultValue: 'Test failed' }))),
    });
  };

  const toggleStatus = (i: SlackIntegration) => {
    const next = i.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
    update.mutate(
      { id: i.id, data: { status: next } },
      {
        onSuccess: () =>
          toast.success(
            next === 'ACTIVE'
              ? t('connections.slack.enabled', { defaultValue: 'Integration enabled' })
              : t('connections.slack.disabled', { defaultValue: 'Integration disabled' }),
          ),
        onError: (e) => toast.error(apiError(e, t('connections.slack.saveError', { defaultValue: 'Failed to update' }))),
      },
    );
  };

  const columns: ColumnDef<SlackIntegration, unknown>[] = [
    {
      id: 'channel',
      header: t('connections.slack.channel', { defaultValue: 'Channel' }),
      cell: ({ row }) => {
        const i = row.original;
        return (
          <div className="flex items-center gap-2">
            <SlackIcon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <span className="text-sm font-medium text-foreground">
              {i.channel || t('connections.slack.webhookChannel', { defaultValue: 'Webhook default' })}
            </span>
          </div>
        );
      },
    },
    {
      id: 'events',
      header: t('connections.slack.events', { defaultValue: 'Events' }),
      cell: ({ row }) => {
        const events = (row.original.events ?? []) as SlackEvent[];
        if (events.length === 0)
          return (
            <Badge tone="info" size="sm">
              {t('connections.slack.allEvents', { defaultValue: 'All events' })}
            </Badge>
          );
        return (
          <div className="flex flex-wrap gap-1">
            {events.map((e) => (
              <Badge key={e} tone="neutral" size="sm">
                {t(`connections.slack.eventLabels.${e}`, {
                  defaultValue: SLACK_EVENT_LABELS[e] ?? e,
                })}
              </Badge>
            ))}
          </div>
        );
      },
    },
    {
      accessorKey: 'status',
      header: t('connections.slack.status', { defaultValue: 'Status' }),
      cell: ({ getValue }) =>
        getValue<string>() === 'ACTIVE' ? (
          <Badge tone="success" size="sm">
            {t('connections.slack.active', { defaultValue: 'Active' })}
          </Badge>
        ) : (
          <Badge tone="neutral" size="sm">
            {t('connections.slack.disabledState', { defaultValue: 'Disabled' })}
          </Badge>
        ),
    },
    {
      id: 'actions',
      header: '',
      size: 48,
      cell: ({ row }) => {
        const i = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton aria-label={t('common.actions', { defaultValue: 'Actions' })} size="sm" variant="ghost">
                <span className="text-lg leading-none" aria-hidden="true">⋯</span>
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => runTest(i)}>
                <Send className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('connections.slack.sendTest', { defaultValue: 'Send test' })}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openEdit(i)}>
                <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('common.edit', { defaultValue: 'Edit' })}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => toggleStatus(i)}>
                <Power className="mr-2 h-4 w-4" aria-hidden="true" />
                {i.status === 'ACTIVE'
                  ? t('connections.slack.disable', { defaultValue: 'Disable' })
                  : t('connections.slack.enable', { defaultValue: 'Enable' })}
              </DropdownMenuItem>
              <DropdownMenuItem className="text-danger focus:text-danger" onClick={() => setDeleteTarget(i)}>
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
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle>{t('connections.slack.title', { defaultValue: 'Slack notifications' })}</CardTitle>
          <CardDescription>
            {t('connections.slack.subtitle', {
              defaultValue: 'Post to Slack via incoming webhooks when leads, forms or bookings come in.',
            })}
          </CardDescription>
        </div>
        <Button onClick={openCreate} className="shrink-0">
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t('connections.slack.createTitle', { defaultValue: 'New Slack integration' })}
        </Button>
      </CardHeader>

      <CardContent>
        <DataTable
          columns={columns}
          data={integrations}
          isLoading={isLoading}
          loadingRowCount={3}
          emptyState={
            <EmptyState
              icon={<SlackIcon className="h-10 w-10" />}
              title={t('connections.slack.empty', { defaultValue: 'No Slack integration yet' })}
              description={t('connections.slack.emptyHint', {
                defaultValue: 'Add an incoming webhook to start posting workspace events to Slack.',
              })}
              action={
                <Button onClick={openCreate} variant="outline">
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t('connections.slack.createTitle', { defaultValue: 'New Slack integration' })}
                </Button>
              }
            />
          }
        />
      </CardContent>

      <SlackFormDialog
        open={formOpen}
        onOpenChange={(o) => {
          setFormOpen(o);
          if (!o) setEditing(null);
        }}
        integration={editing}
        onSubmit={handleSubmit}
        isPending={create.isPending || update.isPending}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null);
        }}
        title={t('connections.slack.deleteTitle', { defaultValue: 'Delete Slack integration' })}
        description={t('connections.slack.deleteDesc', {
          defaultValue: 'Notifications to this webhook will stop. This cannot be undone.',
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
              toast.success(t('connections.slack.deleted', { defaultValue: 'Slack integration deleted' }));
            },
            onError: (e) => toast.error(apiError(e, t('connections.slack.deleteError', { defaultValue: 'Failed to delete' }))),
          })
        }
      />
    </Card>
  );
}
