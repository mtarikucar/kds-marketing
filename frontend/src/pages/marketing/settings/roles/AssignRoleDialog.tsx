import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  Button,
  Field,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@/components/ui';
import type { CustomRole, RoleAssignTarget } from './types';

const NO_ROLE = '__NONE__';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  users: RoleAssignTarget[];
  usersLoading: boolean;
  roles: CustomRole[];
  onSubmit: (payload: { userId: string; roleId: string | null }) => void;
  isPending: boolean;
}

export function AssignRoleDialog({
  open,
  onOpenChange,
  users,
  usersLoading,
  roles,
  onSubmit,
  isPending,
}: Props) {
  const { t } = useTranslation('marketing');
  const [userId, setUserId] = useState('');
  const [roleId, setRoleId] = useState(NO_ROLE);

  useEffect(() => {
    if (!open) {
      setUserId('');
      setRoleId(NO_ROLE);
    }
  }, [open]);

  const userName = (u: RoleAssignTarget) =>
    `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || u.email;

  const canSubmit = !!userId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('roles.assignTitle', { defaultValue: 'Assign a role' })}</DialogTitle>
          <DialogDescription>
            {t('roles.assignDesc', {
              defaultValue:
                'Give a team member a custom role. This replaces their permissions for the workspace.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            onSubmit({ userId, roleId: roleId === NO_ROLE ? null : roleId });
          }}
          className="space-y-4"
        >
          <Field label={t('roles.assignUser', { defaultValue: 'Team member' })} required>
            {({ id }) =>
              usersLoading ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <Select value={userId} onValueChange={setUserId}>
                  <SelectTrigger id={id}>
                    <SelectValue placeholder={t('roles.assignUserPlaceholder', { defaultValue: 'Select a member' })} />
                  </SelectTrigger>
                  <SelectContent>
                    {users.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {userName(u)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
            }
          </Field>

          <Field
            label={t('roles.assignRole', { defaultValue: 'Role' })}
            hint={t('roles.assignRoleHint', {
              defaultValue: 'Choose "No custom role" to fall back to their base role.',
            })}
          >
            {({ id, describedBy }) => (
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger id={id} aria-describedby={describedBy}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_ROLE}>
                    {t('roles.noRole', { defaultValue: 'No custom role' })}
                  </SelectItem>
                  {roles.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending} disabled={!canSubmit}>
              {t('roles.assignSubmit', { defaultValue: 'Assign role' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
