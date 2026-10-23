import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { listRoles } from '@/api/roles';
import { invite, listTeam, removeMember, setRole } from '@/api/team';
import type { InviteOut, MemberOut, RoleDef } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { CopyField } from '@/components/CopyField';
import { ErrorCallout } from '@/components/ErrorCallout';
import { QueryState } from '@/components/QueryState';
import { MemberStatusBadge } from '@/components/StatusBadges';
import {
  Button,
  Callout,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@/components/ui';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { can, roleLabel } from '@/lib/roles';

const TEAM_KEY = ['team'] as const;
const ROLES_KEY = ['roles'] as const;

/** The link an invitee opens; the token is in it and nowhere else. */
export function inviteLink(token: string): string {
  return `${window.location.origin}/invite/${encodeURIComponent(token)}`;
}

function RoleSelect({
  roles,
  value,
  onChange,
  label,
  id,
  disabled,
}: {
  roles: RoleDef[];
  value: string;
  onChange: (key: string) => void;
  label?: string;
  id?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label={label} className="h-8 min-w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {roles.map((role) => (
          <SelectItem key={role.key} value={role.key}>
            {roleLabel(t, role.key, role.name)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  roles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: RoleDef[];
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const defaultRole = roles.find((r) => r.key === 'rep')?.key ?? roles[0]?.key ?? '';
  const [email, setEmail] = useState('');
  const [roleKey, setRoleKey] = useState('');
  // The one-time token lives only here, while the dialog is open.
  const [created, setCreated] = useState<InviteOut | null>(null);

  const create = useMutation({
    mutationFn: invite,
    gcTime: 0,
    onSuccess: async (out) => {
      setCreated(out);
      await queryClient.invalidateQueries({ queryKey: TEAM_KEY });
    },
  });

  const close = (next: boolean) => {
    if (!next) {
      setEmail('');
      setRoleKey('');
      setCreated(null);
      create.reset();
    }
    onOpenChange(next);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ email, role_key: roleKey || defaultRole });
  };

  return (
    // While the one-time link is shown, only the explicit Close button closes the dialog.
    <Dialog open={open} onOpenChange={close}>
      <DialogContent dismissible={created == null}>
        <DialogHeader>
          <DialogTitle>{t('team.dialog.title')}</DialogTitle>
          <DialogDescription>{t('team.dialog.description')}</DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="flex flex-col gap-4">
            <Callout tone="warning" title={t('team.dialog.linkTitle')}>
              {t('team.dialog.linkWarning')}
            </Callout>
            <CopyField label={t('team.dialog.linkTitle')} value={inviteLink(created.invite_token)} />
            <p className="text-caption text-muted-foreground">
              {t('team.dialog.expiresAt', { date: formatDateTime(created.expires_at, i18n.language) })}
            </p>
            <DialogFooter>
              <Button onClick={() => close(false)}>{t('common.close')}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
            <ErrorCallout error={create.error} />
            <Field label={t('fields.email')} required>
              {(ids) => (
                <Input
                  id={ids.id}
                  type="email"
                  autoComplete="off"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              )}
            </Field>
            <Field label={t('fields.role_key')} required>
              {(ids) => (
                <RoleSelect id={ids.id} roles={roles} value={roleKey || defaultRole} onChange={setRoleKey} />
              )}
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" loading={create.isPending}>
                {t('team.dialog.submit')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function TeamPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const session = useSession();
  const canManage = can(session.data, 'team.manage');
  const team = useQuery({ queryKey: TEAM_KEY, queryFn: listTeam });
  const roles = useQuery({ queryKey: ROLES_KEY, queryFn: listRoles });
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<MemberOut | null>(null);

  const changeRole = useMutation({
    mutationFn: ({ id, roleKey }: { id: string; roleKey: string }) => setRole(id, roleKey),
    onSuccess: async () => {
      toast.success(t('team.roleChanged'));
      await queryClient.invalidateQueries({ queryKey: TEAM_KEY });
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeMember(id),
    onSuccess: async () => {
      setRemoving(null);
      toast.success(t('team.removed'));
      await queryClient.invalidateQueries({ queryKey: TEAM_KEY });
    },
    onError: (err) => toast.error(errorMessage(t, err)),
  });

  const roleList = useMemo(() => roles.data ?? [], [roles.data]);
  const { mutate: mutateRole, isPending: rolePending } = changeRole;
  const columns = useMemo<ColumnDef<MemberOut, unknown>[]>(
    () => [
      {
        id: 'member',
        header: t('team.columns.member'),
        accessorFn: (m) => m.display_name ?? m.email,
        cell: ({ row }) => (
          <div className="flex min-w-0 flex-col">
            {row.original.display_name && (
              <span className="truncate font-medium text-foreground">{row.original.display_name}</span>
            )}
            <span className="truncate text-caption text-muted-foreground">{row.original.email}</span>
          </div>
        ),
      },
      {
        id: 'role',
        header: t('team.columns.role'),
        accessorFn: (m) => m.role_key,
        cell: ({ row }) => {
          const m = row.original;
          if (canManage && m.status === 'active' && roleList.length > 0) {
            return (
              <RoleSelect
                roles={roleList}
                value={m.role_key}
                label={t('team.changeRole', { email: m.email })}
                disabled={rolePending}
                onChange={(roleKey) => {
                  if (roleKey !== m.role_key) mutateRole({ id: m.membership_id, roleKey });
                }}
              />
            );
          }
          return roleLabel(t, m.role_key, m.role_name);
        },
      },
      {
        id: 'status',
        header: t('team.columns.status'),
        accessorFn: (m) => m.status,
        cell: ({ row }) => <MemberStatusBadge status={row.original.status} />,
      },
      {
        id: 'since',
        header: t('team.columns.since'),
        accessorFn: (m) => m.created_at,
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground">
            {formatDateTime(row.original.created_at, i18n.language)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('common.actions')}</span>,
        enableSorting: false,
        cell: ({ row }) =>
          canManage && row.original.user_id !== session.data?.user_id ? (
            <Button variant="ghost" size="sm" onClick={() => setRemoving(row.original)}>
              {row.original.status === 'invited' ? t('team.cancelInvite') : t('team.remove')}
            </Button>
          ) : null,
      },
    ],
    [t, i18n.language, canManage, roleList, mutateRole, rolePending, session.data?.user_id],
  );

  const removingInvite = removing?.status === 'invited';

  return (
    <>
      <PageHeader
        title={t('team.title')}
        description={t('team.description')}
        actions={
          canManage ? (
            <Button onClick={() => setInviting(true)} disabled={roleList.length === 0}>
              <UserPlus className="h-4 w-4" aria-hidden="true" />
              {t('team.invite')}
            </Button>
          ) : null
        }
      />
      <QueryState query={team}>
        <DataTable
          columns={columns}
          data={team.data ?? []}
          emptyState={<EmptyState title={t('team.empty')} description={t('team.emptyBody')} />}
        />
      </QueryState>
      {canManage && <InviteDialog open={inviting} onOpenChange={setInviting} roles={roleList} />}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removingInvite ? t('team.cancelInviteTitle') : t('team.removeTitle')}
        description={
          removing
            ? removingInvite
              ? t('team.cancelInviteBody', { email: removing.email })
              : t('team.removeBody', { email: removing.email })
            : undefined
        }
        confirmLabel={removingInvite ? t('team.cancelInvite') : t('team.remove')}
        cancelLabel={t('common.cancel')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.membership_id)}
      />
    </>
  );
}
