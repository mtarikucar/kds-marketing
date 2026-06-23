import { forwardRef } from 'react';
import { Input } from './Input';

/** Consistent placeholder for every phone field in the app (Turkish national format). */
export const PHONE_PLACEHOLDER = '05XX XXX XX XX';

/** Allow only phone-shaped characters while typing (digits, +, spaces, dashes, parens). */
const sanitizeLive = (v: string) => v.replace(/[^\d+()\-\s]/g, '');

/**
 * Canonical form for storage/submit: a leading `+` (if present) plus digits only —
 * spaces, dashes and parens are dropped. Keeps a leading 0 (national format) as-is,
 * so callers that need digits (telephony) and validators that expect E.164 both work.
 */
export const normalizePhone = (v: string): string => {
  const s = (v ?? '').trim();
  if (!s) return '';
  const plus = s.startsWith('+') ? '+' : '';
  return plus + s.replace(/[^\d]/g, '');
};

/**
 * The single phone-number input used everywhere in the app. A thin, drop-in
 * wrapper over the standard `Input`:
 *  - tel semantics (`type`/`inputMode`/`autoComplete`) → numeric keypad on mobile + autofill
 *  - one consistent placeholder
 *  - live-sanitises out non-phone characters as you type
 *  - normalises to `+`/digits on blur, propagating the cleaned value to the field
 *
 * API-compatible with `<Input>` so it works both with react-hook-form
 * (`<PhoneInput {...register('phone')} />`) and controlled (`value`/`onChange`).
 */
export const PhoneInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ placeholder, onChange, onBlur, ...props }, ref) => {
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const cleaned = sanitizeLive(e.target.value);
      if (cleaned !== e.target.value) e.target.value = cleaned;
      onChange?.(e);
    };
    const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
      const normalized = normalizePhone(e.target.value);
      if (normalized !== e.target.value) {
        e.target.value = normalized;
        // Propagate the cleaned value so RHF / controlled state stores the canonical form.
        onChange?.(e as unknown as React.ChangeEvent<HTMLInputElement>);
      }
      onBlur?.(e);
    };
    return (
      <Input
        ref={ref}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        placeholder={placeholder ?? PHONE_PLACEHOLDER}
        onChange={handleChange}
        onBlur={handleBlur}
        {...props}
      />
    );
  },
);
PhoneInput.displayName = 'PhoneInput';
