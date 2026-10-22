import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MoneyInput } from '@/components/forms';
import { minorDigits, minorToInput, parseMinor } from './format';

describe('money in minor units', () => {
  it('shows a zero-decimal currency with its whole zeros', () => {
    expect(minorDigits('JPY')).toBe(0);
    expect(minorToInput(1000, minorDigits('JPY'))).toBe('1000');
  });

  it('drops only trailing decimal zeros of a two-decimal currency', () => {
    expect(minorDigits('TRY')).toBe(2);
    expect(minorToInput(1050, 2)).toBe('10.5');
    expect(minorToInput(1000, 2)).toBe('10');
    expect(minorToInput(100050, 2)).toBe('1000.5');
    expect(parseMinor('10.50', 2)).toBe(1050);
    expect(parseMinor('10,50', 2)).toBe(1050);
  });

  it('fills the money input with the amount as typed', () => {
    render(
      <>
        <MoneyInput id="jpy" minor={1000} currency="JPY" onChange={() => {}} />
        <MoneyInput id="try" minor={1050} currency="TRY" onChange={() => {}} />
      </>,
    );
    expect(screen.getByDisplayValue('1000')).toHaveAttribute('id', 'jpy');
    expect(screen.getByDisplayValue('10.5')).toHaveAttribute('id', 'try');
  });
});
