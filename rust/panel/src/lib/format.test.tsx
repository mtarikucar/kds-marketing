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

  it('reads the thousands grouping of the panel language, never a decimal as grouping', () => {
    expect(parseMinor('14.900', 2, 'tr')).toBe(1_490_000);
    expect(parseMinor('14.900,50', 2, 'tr')).toBe(1_490_050);
    expect(parseMinor('1.490.000', 2, 'tr')).toBe(149_000_000);
    expect(parseMinor('12,50', 2, 'tr')).toBe(1250);
    expect(parseMinor('12.5', 2, 'tr')).toBe(1250);
    expect(parseMinor('14,900', 2, 'en')).toBe(1_490_000);
    expect(parseMinor('14,900.50', 2, 'en')).toBe(1_490_050);
    expect(parseMinor('12,50', 2, 'en')).toBe(1250);
    expect(parseMinor('1.000', 0, 'tr')).toBe(1000);
    // Without a language, grouping stays unreadable rather than guessed.
    expect(parseMinor('14.900', 2)).toBeNull();
    expect(parseMinor('14.90.0', 2, 'tr')).toBeNull();
    expect(parseMinor('14.9000', 2, 'tr')).toBeNull();
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
