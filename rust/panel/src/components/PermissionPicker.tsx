import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Checkbox, Label } from '@/components/ui';
import { PERMISSIONS, type Permission } from '@/api/types';

export interface PermissionPickerProps {
  legend: string;
  hint?: string;
  value: readonly Permission[];
  onChange: (next: Permission[]) => void;
  disabled?: boolean;
}

/** One checkbox per permission of the fixed list. */
export function PermissionPicker({ legend, hint, value, onChange, disabled }: PermissionPickerProps) {
  const { t } = useTranslation();
  const id = useId();
  const toggle = (permission: Permission, checked: boolean) => {
    const next = new Set(value);
    if (checked) next.add(permission);
    else next.delete(permission);
    onChange(PERMISSIONS.filter((p) => next.has(p)));
  };
  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={hint ? `${id}-hint` : undefined}>
      <legend className="mb-1 text-sm font-medium text-foreground">{legend}</legend>
      {PERMISSIONS.map((permission) => {
        const boxId = `${id}-${permission}`;
        return (
          <div key={permission} className="flex items-center gap-2">
            <Checkbox
              id={boxId}
              checked={value.includes(permission)}
              onCheckedChange={(checked) => toggle(permission, checked === true)}
              disabled={disabled}
            />
            <Label htmlFor={boxId} className="font-normal">
              {t(`permissions.${permission}`)}
              <span className="ms-2 font-mono text-micro text-muted-foreground">{permission}</span>
            </Label>
          </div>
        );
      })}
      {hint && (
        <p id={`${id}-hint`} className="text-caption text-muted-foreground">
          {hint}
        </p>
      )}
    </fieldset>
  );
}
