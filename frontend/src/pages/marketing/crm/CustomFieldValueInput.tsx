import {
  Input,
  Textarea,
  Switch,
  Checkbox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import type { CustomFieldDef } from './types';

interface CustomFieldValueInputProps {
  field: CustomFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  id?: string;
  describedBy?: string;
  invalid?: boolean;
}

/**
 * One value input for a custom field, rendered by the field's type. Shared by
 * the lead form and the custom-object record form so the type → control mapping
 * lives in one place. Values are kept as a plain map and sent verbatim — the
 * backend validates/coerces against the field defs (single source of truth).
 */
export function CustomFieldValueInput({
  field,
  value,
  onChange,
  id,
  describedBy,
  invalid,
}: CustomFieldValueInputProps) {
  const common = { id, 'aria-describedby': describedBy, 'aria-invalid': invalid };

  switch (field.type) {
    case 'TEXTAREA':
      return <Textarea {...common} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'NUMBER':
      return (
        <Input
          {...common}
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      );
    case 'DATE':
      return (
        <Input
          {...common}
          type="date"
          value={(value as string)?.slice(0, 10) ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
      );
    case 'DATETIME':
      return (
        <Input
          {...common}
          type="datetime-local"
          value={(value as string)?.slice(0, 16) ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
        />
      );
    case 'BOOL':
      return <Switch checked={!!value} onCheckedChange={onChange} />;
    case 'SELECT':
      return (
        <Select value={(value as string) ?? ''} onValueChange={onChange}>
          <SelectTrigger {...common}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case 'MULTISELECT': {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      const toggle = (v: string, on: boolean) => onChange(on ? [...arr, v] : arr.filter((x) => x !== v));
      return (
        <div className="space-y-1.5">
          {(field.options ?? []).map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm">
              <Checkbox checked={arr.includes(o.value)} onCheckedChange={(c) => toggle(o.value, !!c)} />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    default:
      // TEXT, PHONE, EMAIL, URL
      return (
        <Input
          {...common}
          type={field.type === 'EMAIL' ? 'email' : field.type === 'URL' ? 'url' : 'text'}
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/**
 * Seed a custom-field value map: existing values, with required-but-unset BOOLs
 * defaulted to `false` so "off" is a real, submittable value (otherwise the
 * backend rejects an untoggled required BOOL as missing).
 */
export function seedCustomFieldValues(
  fields: CustomFieldDef[],
  existing: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> = existing ? { ...existing } : {};
  for (const f of fields) {
    if (f.type === 'BOOL' && base[f.key] === undefined) base[f.key] = false;
  }
  return base;
}
