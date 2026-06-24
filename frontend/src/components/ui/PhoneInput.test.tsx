import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { PhoneInput, splitPhone, combinePhone } from './PhoneInput';

describe('splitPhone', () => {
  it('splits an E.164 TR number', () => {
    expect(splitPhone('+905321234567')).toEqual({ dial: '90', national: '5321234567' });
  });
  it('defaults to TR for a national (non-+) value', () => {
    expect(splitPhone('05321234567')).toEqual({ dial: '90', national: '05321234567' });
  });
  it('matches a longer dial code first (+971)', () => {
    expect(splitPhone('+971501234567')).toEqual({ dial: '971', national: '501234567' });
  });
});

describe('combinePhone', () => {
  it('builds E.164 and drops the national leading zero + separators', () => {
    expect(combinePhone('90', '0532 123 45 67')).toBe('+905321234567');
  });
  it('empty / zero-only national → empty', () => {
    expect(combinePhone('90', '0')).toBe('');
    expect(combinePhone('90', '')).toBe('');
  });
});

function Harness({ initial = '' }: { initial?: string }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <PhoneInput aria-label="phone" value={v} onChange={setV} />
      <span data-testid="val">{v}</span>
    </>
  );
}

describe('PhoneInput', () => {
  it('emits E.164 with the default +90 as the user types', () => {
    render(<Harness />);
    const input = screen.getByLabelText('phone') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5321234567' } });
    expect(screen.getByTestId('val').textContent).toBe('+905321234567');
  });

  it('strips non-digits from the national part', () => {
    render(<Harness />);
    const input = screen.getByLabelText('phone') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '532abc12' } });
    expect(screen.getByTestId('val').textContent).toBe('+9053212');
  });

  it('changing the country code re-emits with the new dial code', () => {
    render(<Harness initial="+905321234567" />);
    const select = screen.getByLabelText('Ülke kodu') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '49' } });
    expect(screen.getByTestId('val').textContent).toBe('+495321234567');
  });

  it('shows the national part of an existing E.164 value', () => {
    render(<Harness initial="+905321234567" />);
    const input = screen.getByLabelText('phone') as HTMLInputElement;
    expect(input.value).toBe('5321234567');
  });
});
