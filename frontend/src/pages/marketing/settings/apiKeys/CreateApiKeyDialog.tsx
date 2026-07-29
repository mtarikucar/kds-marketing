import { useEffect, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import { Label } from '@/components/ui/Label';
import { Skeleton } from '@/components/ui/Skeleton';
import { usePermissionCatalog } from '../roles/hooks';
import { permissionMeta } from '../roles/types';

// ── Schema ───────────────────────────────────────────────────────────────────
// Mirrors the backend CreateApiKeyDto (api-key.dto.ts): name (≤80) + ≥1 scope.
// 'read'/'write' are legacy shorthands `expandScopes` (mcp-scopes.ts) expands
// into a fixed read/write bundle. The granular options below come from the
// SAME live catalog the Roles & permissions editor uses (GET /roles/catalog
// -> roles/permissions.ts) — without a granular scope selectable here, a
// tool gated on one (e.g. jeeta.reallocate_budget needs settings.manage) was
// only reachable by hand-crafting the POST body, never through this dialog.

const LEGACY_SCOPES = ['read', 'write'] as const;

export const apiKeySchema = z.object({
  name: z.string().min(1, 'required').max(80, 'tooLong'),
  scopes: z.array(z.string()).min(1, 'pickScope'),
});

export type ApiKeyFormValues = z.infer<typeof apiKeySchema>;

interface CreateApiKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: ApiKeyFormValues) => void;
  isPending: boolean;
}

export function CreateApiKeyDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
}: CreateApiKeyDialogProps) {
  const { t } = useTranslation('marketing');
  const { data: catalog, isLoading: catalogLoading } = usePermissionCatalog();
  const granularScopes = useMemo(() => catalog ?? [], [catalog]);

  const form = useForm<ApiKeyFormValues>({
    resolver: zodResolver(apiKeySchema),
    mode: 'onBlur',
    defaultValues: { name: '', scopes: ['read', 'write'] },
  });

  useEffect(() => {
    if (open) form.reset({ name: '', scopes: ['read', 'write'] });
  }, [open, form]);

  // Group the granular catalog by display group, same layout as RoleFormDialog.
  const grouped = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const key of granularScopes) {
      const g = permissionMeta(key).group;
      const arr = out.get(g) ?? [];
      arr.push(key);
      out.set(g, arr);
    }
    return Array.from(out.entries());
  }, [granularScopes]);

  const fieldErr = (msg?: string) =>
    msg ? t([`validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('apiKeys.createTitle', { defaultValue: 'Create API key' })}</DialogTitle>
          <DialogDescription>
            {t('apiKeys.createHint', {
              defaultValue:
                'Name this key and choose its access scopes. The secret is shown only once after creation.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          {/* Name */}
          <Field
            label={t('apiKeys.fields.name', { defaultValue: 'Name' })}
            error={fieldErr(errors.name?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                maxLength={80}
                placeholder={t('apiKeys.fields.namePlaceholder', {
                  defaultValue: 'e.g. Zapier integration',
                })}
                {...form.register('name')}
              />
            )}
          </Field>

          {/* Scopes */}
          <Field
            label={t('apiKeys.fields.scopes', { defaultValue: 'Scopes' })}
            error={fieldErr(errors.scopes?.message as string | undefined)}
            required
          >
            {() => (
              <Controller
                control={form.control}
                name="scopes"
                render={({ field }) => {
                  const selected = new Set(field.value ?? []);
                  const toggle = (scope: string, on: boolean) => {
                    const next = new Set(selected);
                    if (on) next.add(scope);
                    else next.delete(scope);
                    field.onChange(Array.from(next));
                  };
                  return (
                    <div className="space-y-4">
                      {/* Legacy read/write shorthands */}
                      <div className="flex flex-col gap-2">
                        {LEGACY_SCOPES.map((scope) => (
                          <div key={scope} className="flex items-center gap-2">
                            <Checkbox
                              id={`scope-${scope}`}
                              checked={selected.has(scope)}
                              onCheckedChange={(v) => toggle(scope, v === true)}
                            />
                            <Label htmlFor={`scope-${scope}`} className="cursor-pointer">
                              {t(`apiKeys.scope.${scope}`, {
                                defaultValue: scope === 'read' ? 'Read' : 'Write',
                              })}
                            </Label>
                          </div>
                        ))}
                      </div>

                      {/* Granular scopes — the live permission catalog */}
                      <div>
                        <p className="mb-1.5 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
                          {t('apiKeys.granularScopes', { defaultValue: 'Granular scopes' })}
                        </p>
                        <p className="mb-2 text-caption text-muted-foreground">
                          {t('apiKeys.granularScopesHint', {
                            defaultValue:
                              'Grant exactly the authority a specific tool or endpoint needs, instead of the broad read/write bundle above.',
                          })}
                        </p>
                        {catalogLoading ? (
                          <div className="space-y-2">
                            {Array.from({ length: 3 }).map((_, i) => (
                              <Skeleton key={i} className="h-7 w-full" />
                            ))}
                          </div>
                        ) : (
                          <div className="max-h-[16rem] space-y-3 overflow-y-auto rounded-lg border border-border p-3">
                            {grouped.map(([group, keys]) => (
                              <div key={group}>
                                <p className="mb-1 text-caption font-semibold uppercase tracking-wide text-muted-foreground">
                                  {t(`roles.groups.${group}`, { defaultValue: group })}
                                </p>
                                <div className="space-y-1">
                                  {keys.map((key) => {
                                    const meta = permissionMeta(key);
                                    return (
                                      <div key={key} className="flex items-center gap-2">
                                        <Checkbox
                                          id={`scope-${key}`}
                                          checked={selected.has(key)}
                                          onCheckedChange={(v) => toggle(key, v === true)}
                                          aria-label={meta.label}
                                        />
                                        <Label htmlFor={`scope-${key}`} className="cursor-pointer">
                                          {t(`roles.perm.${key}.label`, { defaultValue: meta.label })}
                                          <code className="ml-1.5 text-micro text-muted-foreground">
                                            {key}
                                          </code>
                                        </Label>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }}
              />
            )}
          </Field>

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
              {t('apiKeys.createButton', { defaultValue: 'Create key' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
