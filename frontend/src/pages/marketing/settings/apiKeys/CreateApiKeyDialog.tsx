import { useEffect } from 'react';
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

// ── Schema ───────────────────────────────────────────────────────────────────
// Mirrors the backend CreateApiKeyDto: name (≤80) + ≥1 scope from read/write.

const SCOPES = ['read', 'write'] as const;

export const apiKeySchema = z.object({
  name: z.string().min(1, 'required').max(80, 'tooLong'),
  scopes: z.array(z.enum(SCOPES)).min(1, 'pickScope'),
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

  const form = useForm<ApiKeyFormValues>({
    resolver: zodResolver(apiKeySchema),
    mode: 'onBlur',
    defaultValues: { name: '', scopes: ['read', 'write'] },
  });

  useEffect(() => {
    if (open) form.reset({ name: '', scopes: ['read', 'write'] });
  }, [open, form]);

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
                render={({ field }) => (
                  <div className="flex flex-col gap-2">
                    {SCOPES.map((scope) => {
                      const checked = field.value?.includes(scope) ?? false;
                      return (
                        <div key={scope} className="flex items-center gap-2">
                          <Checkbox
                            id={`scope-${scope}`}
                            checked={checked}
                            onCheckedChange={(v) => {
                              const next = v === true
                                ? [...(field.value ?? []), scope]
                                : (field.value ?? []).filter((s) => s !== scope);
                              field.onChange(next);
                            }}
                          />
                          <Label htmlFor={`scope-${scope}`} className="cursor-pointer">
                            {t(`apiKeys.scope.${scope}`, {
                              defaultValue: scope === 'read' ? 'Read' : 'Write',
                            })}
                          </Label>
                        </div>
                      );
                    })}
                  </div>
                )}
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
