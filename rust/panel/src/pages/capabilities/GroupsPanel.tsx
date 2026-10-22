import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { addGroupMember, createGroup, deleteGroup, removeGroupMember, renameGroup } from '@/api/capabilities';
import type { CapabilityOut, GroupOut } from '@/api/types';
import { Chip } from '@/components/Chip';
import { ErrorCallout } from '@/components/ErrorCallout';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Field,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { invalidateCapabilities } from './queries';

function GroupRow({
  entry,
  capabilities,
  canManage,
  onDelete,
}: {
  entry: GroupOut;
  capabilities: readonly CapabilityOut[];
  canManage: boolean;
  onDelete: (group: GroupOut) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { group, members } = entry;
  const [renaming, setRenaming] = useState<string | null>(null);
  const onError = (err: unknown) => toast.error(errorMessage(t, err));
  const refresh = () => invalidateCapabilities(queryClient);

  const rename = useMutation({
    mutationFn: (name: string) => renameGroup(group.id, name),
    onSuccess: async () => {
      setRenaming(null);
      toast.success(t('capabilities.groupsPanel.renamed'));
      await refresh();
    },
    onError,
  });
  const add = useMutation({
    mutationFn: (capabilityId: string) => addGroupMember(group.id, capabilityId),
    onSuccess: async () => {
      toast.success(t('capabilities.groupsPanel.memberAdded'));
      await refresh();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (capabilityId: string) => removeGroupMember(group.id, capabilityId),
    onSuccess: async () => {
      toast.success(t('capabilities.groupsPanel.memberRemoved'));
      await refresh();
    },
    onError,
  });

  const memberIds = new Set(members.map((m) => m.capability.id));
  const candidates = capabilities.filter(
    (c) => c.capability.status !== 'retired' && !memberIds.has(c.capability.id),
  );

  const onRename = (e: FormEvent) => {
    e.preventDefault();
    if (renaming !== null && renaming.trim() !== '') rename.mutate(renaming.trim());
  };

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        {renaming === null ? (
          <div className="flex min-w-0 flex-col">
            <span className="font-medium text-foreground">{group.name}</span>
            {group.purpose && <span className="text-caption text-muted-foreground">{group.purpose}</span>}
          </div>
        ) : (
          <form className="flex flex-1 items-center gap-2" onSubmit={onRename}>
            <Input
              aria-label={t('capabilities.groupsPanel.name')}
              value={renaming}
              maxLength={64}
              onChange={(e) => setRenaming(e.target.value)}
              autoFocus
            />
            <IconButton type="submit" aria-label={t('common.save')} variant="ghost" size="sm" disabled={rename.isPending}>
              <Check className="h-4 w-4" />
            </IconButton>
            <IconButton aria-label={t('common.cancel')} variant="ghost" size="sm" onClick={() => setRenaming(null)}>
              <X className="h-4 w-4" />
            </IconButton>
          </form>
        )}
        {canManage && renaming === null && (
          <div className="flex items-center gap-1">
            <IconButton
              aria-label={`${t('capabilities.groupsPanel.rename')}: ${group.name}`}
              variant="ghost"
              size="sm"
              onClick={() => setRenaming(group.name)}
            >
              <Pencil className="h-4 w-4" />
            </IconButton>
            <IconButton
              aria-label={`${t('common.delete')}: ${group.name}`}
              variant="ghost"
              size="sm"
              onClick={() => onDelete(entry)}
            >
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {members.length === 0 ? (
          <span className="text-caption text-muted-foreground">{t('capabilities.groupsPanel.noMembers')}</span>
        ) : (
          members.map((m) => (
            <Chip
              key={m.capability.id}
              label={m.capability.name}
              disabled={remove.isPending}
              onRemove={canManage ? () => remove.mutate(m.capability.id) : undefined}
              removeLabel={t('capabilities.groupsPanel.removeMember', { name: m.capability.name })}
            />
          ))
        )}
      </div>
      {canManage && candidates.length > 0 && (
        <Select value="" onValueChange={(id) => add.mutate(id)} disabled={add.isPending}>
          <SelectTrigger
            aria-label={`${t('capabilities.groupsPanel.addMember')}: ${group.name}`}
            className="h-8 sm:w-64"
          >
            <SelectValue placeholder={t('capabilities.groupsPanel.addMemberPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((c) => (
              <SelectItem key={c.capability.id} value={c.capability.id}>
                {c.capability.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </li>
  );
}

/**
 * The capability groups: named sets a strategy channel can be narrowed to. Create, rename and
 * delete a group; add a capability through a select, remove one from its chip.
 */
export function GroupsPanel({
  groups,
  capabilities,
  canManage,
}: {
  groups: readonly GroupOut[];
  capabilities: readonly CapabilityOut[];
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [deleting, setDeleting] = useState<GroupOut | null>(null);

  const create = useMutation({
    mutationFn: createGroup,
    onSuccess: async () => {
      setName('');
      setPurpose('');
      toast.success(t('capabilities.groupsPanel.created'));
      await invalidateCapabilities(queryClient);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteGroup(id),
    onSuccess: async () => {
      setDeleting(null);
      toast.success(t('capabilities.groupsPanel.deleted'));
      await invalidateCapabilities(queryClient);
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });

  const onCreate = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() === '') return;
    create.mutate({ name: name.trim(), purpose: purpose.trim() || undefined });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('capabilities.groupsPanel.title')}</CardTitle>
        <CardDescription>{t('capabilities.groupsPanel.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {canManage && (
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={onCreate} noValidate>
            <Field label={t('capabilities.groupsPanel.name')} className="sm:flex-1" required>
              {(ids) => <Input id={ids.id} maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />}
            </Field>
            <Field label={t('capabilities.groupsPanel.purpose')} className="sm:flex-1">
              {(ids) => <Input id={ids.id} value={purpose} onChange={(e) => setPurpose(e.target.value)} />}
            </Field>
            <Button type="submit" loading={create.isPending} disabled={name.trim() === ''}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('capabilities.groupsPanel.create')}
            </Button>
          </form>
        )}
        <ErrorCallout error={create.error} />
        {groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('capabilities.groupsPanel.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {groups.map((entry) => (
              <GroupRow
                key={entry.group.id}
                entry={entry}
                capabilities={capabilities}
                canManage={canManage}
                onDelete={setDeleting}
              />
            ))}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t('capabilities.groupsPanel.deleteTitle')}
        description={deleting ? t('capabilities.groupsPanel.deleteBody', { name: deleting.group.name }) : undefined}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.group.id)}
      />
    </Card>
  );
}
