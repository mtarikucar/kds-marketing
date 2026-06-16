import { useEffect, useMemo } from 'react';
import { useForm, Controller, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  Button,
  Field,
  Input,
  Checkbox,
  Skeleton,
} from '@/components/ui';
import { permissionMeta, type CustomRole } from './types';

const roleSchema = z.object({
  name: z.string().trim().min(1, 'nameRequired').max(80, 'nameTooLong'),
  permissions: z.array(z.string()),
});
export type RoleFormValues = z.infer<typeof roleSchema>;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass a role to edit, or null to create. */
  role?: CustomRole | null;
  /** Live permission catalog from GET /roles/catalog. */
  catalog: string[];
  catalogLoading: boolean;
  onSubmit: (values: RoleFormValues) => void;
  isPending: boolean;
}

export function RoleFormDialog({
  open,
  onOpenChange,
  role,
  catalog,
  catalogLoading,
  onSubmit,
  isPending,
}: Props) {
  const { t } = useTranslation('marketing');
  const isEdit = !!role;

  const form = useForm<RoleFormValues>({
    resolver: zodResolver(roleSchema),
    mode: 'onBlur',
    defaultValues: { name: '', permissions: [] },
  });

  useEffect(() => {
    if (!open) return;
    form.reset(
      role
        ? { name: role.name, permissions: role.permissions ?? [] }
        : { name: '', permissions: [] },
    );
  }, [role, open, form]);

  // Group the catalog by display group for a tidy checkbox layout.
  const grouped = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const key of catalog) {
      const g = permissionMeta(key).group;
      const arr = out.get(g) ?? [];
      arr.push(key);
      out.set(g, arr);
    }
    return Array.from(out.entries());
  }, [catalog]);

  const nameErr = form.formState.errors.name?.message
    ? t('roles.validation.nameRequired', { defaultValue: 'A role name is required' })
    : undefined;

  const handleSubmit: SubmitHandler<RoleFormValues> = (values) => onSubmit(values);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('roles.editTitle', { defaultValue: 'Edit role' })
              : t('roles.createTitle', { defaultValue: 'New role' })}
          </DialogTitle>
          <DialogDescription>
            {t('roles.dialogDesc', {
              defaultValue: 'Name the role and choose the permissions it grants.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-5">
          <Field
            label={t('roles.name', { defaultValue: 'Role name' })}
            error={nameErr}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={t('roles.namePlaceholder', { defaultValue: 'e.g. Senior closer' })}
                {...form.register('name')}
              />
            )}
          </Field>

          <div>
            <p className="mb-1 text-sm font-medium text-foreground">
              {t('roles.permissions', { defaultValue: 'Permissions' })}
            </p>
            <p className="mb-3 text-caption text-muted-foreground">
              {t('roles.permissionsHint', {
                defaultValue: 'Select what this role can do. Unchecked actions are denied.',
              })}
            </p>

            {catalogLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : (
              <Controller
                control={form.control}
                name="permissions"
                render={({ field }) => {
                  const selected = new Set(field.value);
                  const toggle = (key: string, on: boolean) => {
                    const next = new Set(selected);
                    if (on) next.add(key);
                    else next.delete(key);
                    field.onChange(Array.from(next));
                  };
                  return (
                    <div className="max-h-[20rem] space-y-4 overflow-y-auto rounded-lg border border-border p-3">
                      {grouped.map(([group, keys]) => (
                        <div key={group}>
                          <p className="mb-1.5 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
                            {t(`roles.groups.${group}`, { defaultValue: group })}
                          </p>
                          <div className="space-y-1.5">
                            {keys.map((key) => {
                              const meta = permissionMeta(key);
                              return (
                                <label
                                  key={key}
                                  className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-muted"
                                >
                                  <Checkbox
                                    checked={selected.has(key)}
                                    onCheckedChange={(c) => toggle(key, c === true)}
                                    aria-label={meta.label}
                                  />
                                  <span className="min-w-0">
                                    <span className="block text-sm font-medium text-foreground">
                                      {t(`roles.perm.${key}.label`, { defaultValue: meta.label })}
                                    </span>
                                    {meta.description && (
                                      <span className="block text-caption text-muted-foreground">
                                        {t(`roles.perm.${key}.desc`, { defaultValue: meta.description })}
                                      </span>
                                    )}
                                    <code className="text-micro text-muted-foreground">{key}</code>
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                }}
              />
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending}>
              {isEdit
                ? t('common.save', { defaultValue: 'Save' })
                : t('roles.createTitle', { defaultValue: 'New role' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
