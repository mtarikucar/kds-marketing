import { useEffect, useMemo } from 'react';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import {
  optionSchema,
  type OptionFormValues,
  IVR_ACTIONS,
  IVR_DIGITS,
  ACTION_LABELS,
  type IvrMenu,
} from './schema';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The menu this option is being added to (for self-target exclusion + dup digit guard). */
  menu: IvrMenu | null;
  /** All workspace menus — candidate SUBMENU targets. */
  allMenus: IvrMenu[];
  onSubmit: (values: OptionFormValues) => void;
  isPending: boolean;
}

const EMPTY: OptionFormValues = {
  digit: '1',
  label: '',
  action: 'SUBMENU',
  targetMenuId: '',
  dialNumber: '',
};

export function OptionFormDialog({
  open,
  onOpenChange,
  menu,
  allMenus,
  onSubmit,
  isPending,
}: Props) {
  const { t } = useTranslation('marketing');

  const form = useForm<OptionFormValues>({
    resolver: zodResolver(optionSchema),
    mode: 'onBlur',
    defaultValues: EMPTY,
  });

  const action = form.watch('action');

  // Digits already mapped on this menu can't be reused (backend rejects dupes).
  const usedDigits = useMemo(
    () => new Set((menu?.options ?? []).map((o) => o.digit)),
    [menu],
  );

  // On open, default the digit to the first FREE keypad key. A hard-coded '1'
  // pre-selected an already-mapped (and disabled) digit on a menu whose first
  // option is '1', so adding a 2nd option submitted '1' and 400d on the backend
  // dup-digit guard — on the most common add-another-option flow.
  useEffect(() => {
    if (open) {
      const firstFree = IVR_DIGITS.find((d) => !usedDigits.has(d)) ?? IVR_DIGITS[0];
      form.reset({ ...EMPTY, digit: firstFree });
    }
  }, [open, form, usedDigits]);

  // Candidate submenu targets: every OTHER menu (a SUBMENU can't target itself).
  const targetCandidates = useMemo(
    () => allMenus.filter((m) => m.id !== menu?.id),
    [allMenus, menu],
  );

  const fieldErr = (msg?: string) =>
    msg ? t([`ivr.validation.${msg}`, `validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<OptionFormValues> = (values) => {
    // Strip irrelevant fields per action so the payload matches the backend DTO.
    const payload: OptionFormValues = {
      digit: values.digit,
      label: values.label,
      action: values.action,
      targetMenuId: values.action === 'SUBMENU' ? values.targetMenuId : '',
      dialNumber: values.action === 'DIAL' ? values.dialNumber : '',
    };
    onSubmit(payload);
  };

  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('ivr.option.createTitle', { defaultValue: 'Add keypad option' })}</DialogTitle>
          <DialogDescription>
            {menu
              ? t('ivr.option.dialogDesc', {
                  defaultValue: 'Map a keypad digit on "{{name}}" to an action.',
                  name: menu.name,
                })
              : t('ivr.option.dialogDescGeneric', {
                  defaultValue: 'Map a keypad digit to an action.',
                })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          <div className="grid grid-cols-[7rem_1fr] gap-3">
            <Field
              label={t('ivr.option.digit', { defaultValue: 'Digit' })}
              error={fieldErr(errors.digit?.message)}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Controller
                  control={form.control}
                  name="digit"
                  render={({ field: f }) => (
                    <Select value={f.value} onValueChange={f.onChange}>
                      <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {IVR_DIGITS.map((d) => (
                          <SelectItem key={d} value={d} disabled={usedDigits.has(d)}>
                            {d}
                            {usedDigits.has(d)
                              ? ` (${t('ivr.option.digitUsed', { defaultValue: 'in use' })})`
                              : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>

            <Field
              label={t('ivr.option.label', { defaultValue: 'Label' })}
              error={fieldErr(errors.label?.message)}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder={t('ivr.option.labelPlaceholder', { defaultValue: 'e.g. Sales' })}
                  {...form.register('label')}
                />
              )}
            </Field>
          </div>

          <Field
            label={t('ivr.option.action', { defaultValue: 'Action' })}
            error={fieldErr(errors.action?.message)}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Controller
                control={form.control}
                name="action"
                render={({ field: f }) => (
                  <Select value={f.value} onValueChange={f.onChange}>
                    <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {IVR_ACTIONS.map((a) => (
                        <SelectItem key={a} value={a}>
                          {t(`ivr.actions.${a}`, { defaultValue: ACTION_LABELS[a] })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            )}
          </Field>

          {action === 'SUBMENU' && (
            <Field
              label={t('ivr.option.targetMenu', { defaultValue: 'Target menu' })}
              error={fieldErr(errors.targetMenuId?.message)}
              hint={
                targetCandidates.length === 0
                  ? t('ivr.option.noTargets', {
                      defaultValue: 'Create another menu first to use as a submenu target.',
                    })
                  : undefined
              }
              required
            >
              {({ id, describedBy, invalid }) => (
                <Controller
                  control={form.control}
                  name="targetMenuId"
                  render={({ field: f }) => (
                    <Select
                      value={f.value || undefined}
                      onValueChange={f.onChange}
                      disabled={targetCandidates.length === 0}
                    >
                      <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid}>
                        <SelectValue
                          placeholder={t('ivr.option.selectMenu', { defaultValue: 'Select a menu' })}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {targetCandidates.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              )}
            </Field>
          )}

          {action === 'DIAL' && (
            <Field
              label={t('ivr.option.dialNumber', { defaultValue: 'Forward to number' })}
              error={fieldErr(errors.dialNumber?.message)}
              hint={t('ivr.option.dialHint', { defaultValue: 'E.164 format, e.g. +14155550123' })}
              required
            >
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  inputMode="tel"
                  placeholder="+14155550123"
                  {...form.register('dialNumber')}
                />
              )}
            </Field>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending}>
              {t('ivr.option.add', { defaultValue: 'Add option' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
