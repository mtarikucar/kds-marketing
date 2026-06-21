import { assertNetsantralConfig } from './telephony-config.util';

describe('assertNetsantralConfig', () => {
  it('passes with username, password, trunk', () => {
    expect(() => assertNetsantralConfig({ username: '8508407303', password: 'pw' }, { trunk: '8508407303' })).not.toThrow();
  });
  it('throws without username', () => {
    expect(() => assertNetsantralConfig({ password: 'pw' }, { trunk: '850' })).toThrow(/username/i);
  });
  it('throws without password', () => {
    expect(() => assertNetsantralConfig({ username: '850' }, { trunk: '850' })).toThrow(/password/i);
  });
  it('throws without a numeric trunk', () => {
    expect(() => assertNetsantralConfig({ username: '850', password: 'pw' }, { trunk: '' })).toThrow(/trunk/i);
  });
});
