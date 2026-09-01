import { isCustomDomainsEnabled } from './custom-domains.config';

/**
 * The flag is rendered from a repo Variable, so an operator can and will spell
 * OFF as '0' or 'false'. The original `!!process.env.X` read both as ON — which
 * would have armed the Host-header middleware and let tenants register
 * hostnames that never serve TLS.
 */
describe('isCustomDomainsEnabled', () => {
  const real = process.env.CUSTOM_DOMAINS_ENABLED;

  afterEach(() => {
    if (real === undefined) delete process.env.CUSTOM_DOMAINS_ENABLED;
    else process.env.CUSTOM_DOMAINS_ENABLED = real;
  });

  it('is off when unset', () => {
    delete process.env.CUSTOM_DOMAINS_ENABLED;
    expect(isCustomDomainsEnabled()).toBe(false);
  });

  it.each(['', '  ', '0', 'false', 'off', 'no'])('is off for %p', (v) => {
    process.env.CUSTOM_DOMAINS_ENABLED = v;
    expect(isCustomDomainsEnabled()).toBe(false);
  });

  it.each(['1', 'true', 'on', 'TRUE ', ' On'])('is on for %p', (v) => {
    process.env.CUSTOM_DOMAINS_ENABLED = v;
    expect(isCustomDomainsEnabled()).toBe(true);
  });
});
