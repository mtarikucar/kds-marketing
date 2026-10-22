import { useEffect, useState, type ReactNode } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, IconButton, Input } from '@/components/ui';
import { minorDigits, parseMinor } from '@/lib/format';

/**
 * An editable list: one bordered row per item with a remove button, and an add button below.
 * `renderRow` draws the fields of one item and patches it through `update`.
 */
export function ListRows<T>({
  items,
  onChange,
  makeItem,
  renderRow,
  addLabel,
  removeLabel,
}: {
  items: readonly T[];
  onChange: (next: T[]) => void;
  makeItem: () => T;
  renderRow: (item: T, update: (patch: Partial<T>) => void, index: number) => ReactNode;
  addLabel: string;
  removeLabel: string;
}) {
  const update = (index: number, patch: Partial<T>) =>
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, index) => (
        <div key={index} className="flex items-start gap-2 rounded-lg border border-border p-3">
          <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2">{renderRow(item, (patch) => update(index, patch), index)}</div>
          <IconButton
            aria-label={`${removeLabel} ${index + 1}`}
            variant="ghost"
            size="sm"
            onClick={() => onChange(items.filter((_, i) => i !== index))}
          >
            <Trash2 className="h-4 w-4" />
          </IconButton>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => onChange([...items, makeItem()])}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        {addLabel}
      </Button>
    </div>
  );
}

/** A whole-number input; an empty field reads as `null`. */
export function WholeNumberInput({
  id,
  value,
  onChange,
  min,
  max,
  describedBy,
  'aria-label': ariaLabel,
}: {
  id?: string;
  value: number | null;
  onChange: (next: number | null) => void;
  min?: number;
  max?: number;
  describedBy?: string;
  'aria-label'?: string;
}) {
  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      step={1}
      min={min}
      max={max}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      value={value ?? ''}
      onChange={(e) => {
        const raw = e.target.value.trim();
        if (raw === '') return onChange(null);
        const n = Number(raw);
        if (Number.isInteger(n)) onChange(n);
      }}
    />
  );
}

/**
 * An amount typed in major units of `currency` (`12,50`), handed on in minor units (`1250`). The
 * text is kept as typed, so a half-written amount (`12,`) is not rewritten under the cursor.
 */
export function MoneyInput({
  id,
  minor,
  currency,
  onChange,
  describedBy,
  required,
}: {
  id?: string;
  minor: number | null;
  currency: string;
  onChange: (minor: number | null) => void;
  describedBy?: string;
  required?: boolean;
}) {
  const { i18n } = useTranslation();
  const digits = minorDigits(currency);
  const show = (value: number | null) =>
    value === null ? '' : (value / 10 ** digits).toFixed(digits).replace(/\.?0+$/, '');
  const [text, setText] = useState(() => show(minor));
  // Follow a value changed from outside (a reset), but not the echo of what was just typed.
  useEffect(() => {
    if (parseMinor(text, digits) !== minor) setText(show(minor));
  }, [minor, digits]);
  const invalid = text.trim() !== '' && parseMinor(text, digits) === null;
  return (
    <Input
      id={id}
      inputMode="decimal"
      autoComplete="off"
      lang={i18n.language}
      required={required}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value.trim() === '') return onChange(null);
        const parsed = parseMinor(e.target.value, digits);
        if (parsed !== null) onChange(parsed);
      }}
    />
  );
}
