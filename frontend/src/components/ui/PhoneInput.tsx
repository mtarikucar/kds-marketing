import { forwardRef, useEffect, useRef, useState } from 'react';
import { Input } from './Input';
import { cn } from './cn';

/** National-number placeholder shown next to the country code. */
export const PHONE_PLACEHOLDER = '5XX XXX XX XX';

/** Country dial codes offered in the prefix selector (Turkey is the default). */
export const PHONE_COUNTRIES = [
  { code: 'TR', dial: '90', flag: '🇹🇷' },
  { code: 'US', dial: '1', flag: '🇺🇸' },
  { code: 'GB', dial: '44', flag: '🇬🇧' },
  { code: 'DE', dial: '49', flag: '🇩🇪' },
  { code: 'NL', dial: '31', flag: '🇳🇱' },
  { code: 'FR', dial: '33', flag: '🇫🇷' },
  { code: 'AZ', dial: '994', flag: '🇦🇿' },
  { code: 'RU', dial: '7', flag: '🇷🇺' },
  { code: 'AE', dial: '971', flag: '🇦🇪' },
  { code: 'SA', dial: '966', flag: '🇸🇦' },
] as const;

const DEFAULT_DIAL = '90';
// longest dial code first, so '+90' matches before '+9'/'+1' etc.
const DIALS_DESC = [...PHONE_COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);

/** Split a stored value into a dial code + national part (best-effort). */
export function splitPhone(value: string): { dial: string; national: string } {
  const s = (value ?? '').trim();
  if (s.startsWith('+')) {
    const digits = s.slice(1).replace(/\D/g, '');
    const c = DIALS_DESC.find((x) => digits.startsWith(x.dial));
    if (c) return { dial: c.dial, national: digits.slice(c.dial.length) };
    return { dial: DEFAULT_DIAL, national: digits };
  }
  // No country code stored — treat as a national number under the default country.
  return { dial: DEFAULT_DIAL, national: s.replace(/\D/g, '') };
}

/** Canonical E.164 value: `+<dial><national>` with the national leading zero(s) dropped. */
export function combinePhone(dial: string, national: string): string {
  const nat = national.replace(/\D/g, '').replace(/^0+/, '');
  return nat ? `+${dial}${nat}` : '';
}

export interface PhoneInputProps {
  /** Stored value (E.164, e.g. `+905321234567`). */
  value?: string;
  /** Emits the canonical E.164 string. */
  onChange?: (value: string) => void;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  id?: string;
  name?: string;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

/**
 * The single phone-number input used everywhere in the app: a country dial-code
 * selector (🇹🇷 +90 by default) plus the national number. Always emits a canonical
 * E.164 value (`+90…`). The visible flag + `+code` make every phone field look the
 * same across the system.
 *
 * Controlled (`value` / `onChange(string)`). Internal state preserves what the user
 * typed (incl. a leading 0) while the emitted value stays clean; it re-syncs when the
 * `value` prop changes from outside (form reset / async load). Use with react-hook-form
 * via `<Controller>`.
 */
export const PhoneInput = forwardRef<HTMLInputElement, PhoneInputProps>(function PhoneInput(
  { value, onChange, onBlur, id, name, className, disabled, placeholder, ...aria },
  ref,
) {
  const init = splitPhone(value ?? '');
  const [dial, setDial] = useState(init.dial);
  const [national, setNational] = useState(init.national);
  const lastEmitted = useRef<string | undefined>(undefined);

  // Re-sync from the prop only on EXTERNAL changes (not our own emits) so typing a
  // leading 0 isn't eaten by the round-trip through the parent.
  useEffect(() => {
    if (value !== lastEmitted.current) {
      const p = splitPhone(value ?? '');
      setDial(p.dial);
      setNational(p.national);
    }
  }, [value]);

  const update = (d: string, natRaw: string) => {
    const nat = natRaw.replace(/\D/g, '');
    setDial(d);
    setNational(nat);
    const v = combinePhone(d, nat);
    lastEmitted.current = v;
    onChange?.(v);
  };

  return (
    <div className={cn('flex w-full', className)}>
      <select
        aria-label="Ülke kodu"
        value={dial}
        disabled={disabled}
        onChange={(e) => update(e.target.value, national)}
        className={cn(
          'h-9 shrink-0 rounded-l-lg border border-r-0 border-border-strong bg-surface pl-2 pr-1 text-sm text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-primary',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        {PHONE_COUNTRIES.map((c) => (
          <option key={c.code} value={c.dial}>
            {c.flag} +{c.dial}
          </option>
        ))}
      </select>
      <Input
        ref={ref}
        id={id}
        name={name}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        disabled={disabled}
        value={national}
        onChange={(e) => update(dial, e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder ?? PHONE_PLACEHOLDER}
        className="rounded-l-none"
        {...aria}
      />
    </div>
  );
});
PhoneInput.displayName = 'PhoneInput';
