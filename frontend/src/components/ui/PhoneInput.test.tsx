import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { PhoneInput, normalizePhone } from './PhoneInput';

describe('normalizePhone', () => {
  it('drops spaces / dashes / parens, keeps + and digits', () => {
    expect(normalizePhone('+90 (532) 111-22-33')).toBe('+905321112233');
  });
  it('keeps a leading 0 national number', () => {
    expect(normalizePhone('0532 111 22 33')).toBe('05321112233');
  });
  it('empty / whitespace stays empty', () => {
    expect(normalizePhone('')).toBe('');
    expect(normalizePhone('   ')).toBe('');
  });
});

function Harness() {
  const [v, setV] = useState('');
  return (
    <>
      <PhoneInput aria-label="phone" value={v} onChange={(e) => setV(e.target.value)} />
      <span data-testid="val">{v}</span>
    </>
  );
}

describe('PhoneInput', () => {
  it('sanitises non-phone characters out as you type', () => {
    render(<Harness />);
    const input = screen.getByLabelText('phone') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0532abc111' } });
    expect(screen.getByTestId('val').textContent).toBe('0532111');
  });

  it('normalises to +/digits on blur and propagates the cleaned value', () => {
    render(<Harness />);
    const input = screen.getByLabelText('phone') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0532 111 22 33' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('val').textContent).toBe('05321112233');
  });

  it('renders tel semantics for mobile keypad + autofill', () => {
    render(<Harness />);
    const input = screen.getByLabelText('phone') as HTMLInputElement;
    expect(input.getAttribute('type')).toBe('tel');
    expect(input.getAttribute('inputmode')).toBe('tel');
    expect(input.getAttribute('autocomplete')).toBe('tel');
  });
});
