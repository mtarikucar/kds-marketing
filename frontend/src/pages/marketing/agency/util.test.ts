import { describe, it, expect } from 'vitest';
import { apiError, isRebillingNotConfigured, formatMoney, dateInputToIso } from './util';

describe('agency util', () => {
  describe('isRebillingNotConfigured', () => {
    it('detects the structured REBILLING_NOT_CONFIGURED 503 the backend raises', () => {
      const err = {
        response: { status: 503, data: { message: { code: 'REBILLING_NOT_CONFIGURED', message: 'rebilling not configured (Stripe Connect env unset)' } } },
      };
      expect(isRebillingNotConfigured(err)).toBe(true);
    });

    it('detects the plain 503 message variant', () => {
      const err = { response: { status: 503, data: { message: 'rebilling not configured (location has no connected Stripe account)' } } };
      expect(isRebillingNotConfigured(err)).toBe(true);
    });

    it('is false for an unrelated error', () => {
      expect(isRebillingNotConfigured({ response: { status: 400, data: { message: 'bad request' } } })).toBe(false);
      expect(isRebillingNotConfigured(new Error('network'))).toBe(false);
      expect(isRebillingNotConfigured(undefined)).toBe(false);
    });
  });

  describe('apiError', () => {
    it('reads a string message', () => {
      expect(apiError({ response: { data: { message: 'boom' } } }, 'fallback')).toBe('boom');
    });
    it('reads the first of an array message', () => {
      expect(apiError({ response: { data: { message: ['first', 'second'] } } }, 'fallback')).toBe('first');
    });
    it('reads a nested object message', () => {
      expect(apiError({ response: { data: { message: { code: 'X', message: 'nested' } } } }, 'fallback')).toBe('nested');
    });
    it('falls back when no message', () => {
      expect(apiError({}, 'fallback')).toBe('fallback');
    });
  });

  describe('formatMoney', () => {
    it('renders an em dash for empty', () => {
      expect(formatMoney(null)).toBe('—');
      expect(formatMoney('')).toBe('—');
    });
    it('formats a decimal string', () => {
      expect(formatMoney('100.00', 'USD')).toMatch(/100/);
    });
  });

  describe('dateInputToIso', () => {
    it('maps a date input to UTC-midnight ISO', () => {
      expect(dateInputToIso('2026-01-15')).toBe('2026-01-15T00:00:00.000Z');
    });
  });
});
