import { useEffect } from 'react';
import { useForm, Controller, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
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
  Input,
  Textarea,
  Switch,
} from '@/components/ui';
import { menuSchema, type MenuFormValues, type IvrMenu } from './schema';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass a menu to edit, or null/undefined to create. */
  menu?: IvrMenu | null;
  onSubmit: (values: MenuFormValues) => void;
  isPending: boolean;
}

const EMPTY: MenuFormValues = { name: '', greeting: '', enabled: true, isRoot: false };

export function MenuFormDialog({ open, onOpenChange, menu, onSubmit, isPending }: Props) {
  const { t } = useTranslation('marketing');
  const isEdit = !!menu;

  const form = useForm<MenuFormValues>({
    resolver: zodResolver(menuSchema),
    mode: 'onBlur',
    defaultValues: EMPTY,
  });

  useEffect(() => {
    if (!open) return;
    if (menu) {
      form.reset({
        name: menu.name,
        greeting: menu.greeting,
        enabled: menu.enabled,
        isRoot: menu.isRoot,
      });
    } else {
      form.reset(EMPTY);
    }
  }, [menu, open, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`ivr.validation.${msg}`, `validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<MenuFormValues> = (values) => onSubmit(values);
  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('ivr.menu.editTitle', { defaultValue: 'Edit menu' })
              : t('ivr.menu.createTitle', { defaultValue: 'New IVR menu' })}
          </DialogTitle>
          <DialogDescription>
            {t('ivr.menu.dialogDesc', {
              defaultValue:
                'A menu greets the caller, then offers keypad options. Mark one menu as the root to answer inbound calls.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <Field
            label={t('ivr.menu.name', { defaultValue: 'Name' })}
            error={fieldErr(errors.name?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Input
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder={t('ivr.menu.namePlaceholder', { defaultValue: 'e.g. Main menu' })}
                {...form.register('name')}
              />
            )}
          </Field>

          <Field
            label={t('ivr.menu.greeting', { defaultValue: 'Greeting' })}
            error={fieldErr(errors.greeting?.message)}
            hint={t('ivr.menu.greetingHint', {
              defaultValue:
                'Spoken to the caller (or paste an https:// audio URL to play a recording).',
            })}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                rows={3}
                placeholder={t('ivr.menu.greetingPlaceholder', {
                  defaultValue: 'Thank you for calling. Press 1 for sales, 2 for support.',
                })}
                {...form.register('greeting')}
              />
            )}
          </Field>

          <Controller
            control={form.control}
            name="enabled"
            render={({ field: f }) => (
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t('ivr.menu.enabled', { defaultValue: 'Enabled' })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('ivr.menu.enabledHint', {
                      defaultValue: 'Disabled menus are skipped by the phone tree.',
                    })}
                  </p>
                </div>
                <Switch
                  checked={!!f.value}
                  onCheckedChange={f.onChange}
                  aria-label={t('ivr.menu.enabled', { defaultValue: 'Enabled' })}
                />
              </div>
            )}
          />

          <Controller
            control={form.control}
            name="isRoot"
            render={({ field: f }) => (
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {t('ivr.menu.isRoot', { defaultValue: 'Root menu' })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('ivr.menu.isRootHint', {
                      defaultValue:
                        'Answers inbound calls. Setting this here demotes any other root menu.',
                    })}
                  </p>
                </div>
                <Switch
                  checked={!!f.value}
                  onCheckedChange={f.onChange}
                  aria-label={t('ivr.menu.isRoot', { defaultValue: 'Root menu' })}
                />
              </div>
            )}
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending}>
              {isEdit
                ? t('common.save', { defaultValue: 'Save' })
                : t('ivr.menu.createTitle', { defaultValue: 'New IVR menu' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
