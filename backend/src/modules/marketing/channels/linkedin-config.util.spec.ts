import { BadRequestException } from '@nestjs/common';
import { assertLinkedinEngagementSecrets } from './linkedin-config.util';

/**
 * LinkedIn engagement channel credential validation. Requires an accessToken
 * (the OAuth token carrying w_organization_social / r_organization_social).
 * Failing at save-time with a clear message beats an opaque /rest error on the
 * first comment-reply. The channel stays inert behind its capability flag even
 * with a valid token until Community Management is approved.
 */
describe('assertLinkedinEngagementSecrets', () => {
  it('accepts a present, non-blank access token (no throw)', () => {
    expect(() => assertLinkedinEngagementSecrets({ accessToken: 'AQX_tok123' })).not.toThrow();
  });

  it('rejects missing accessToken (throws BadRequestException)', () => {
    expect(() => assertLinkedinEngagementSecrets({})).toThrow(BadRequestException);
    expect(() => assertLinkedinEngagementSecrets(undefined)).toThrow(BadRequestException);
  });

  it('rejects blank / whitespace accessToken (throws BadRequestException)', () => {
    expect(() => assertLinkedinEngagementSecrets({ accessToken: '' })).toThrow(BadRequestException);
    expect(() => assertLinkedinEngagementSecrets({ accessToken: '   ' })).toThrow(BadRequestException);
  });

  it('error message mentions accessToken', () => {
    expect(() => assertLinkedinEngagementSecrets({})).toThrow(/accessToken/i);
  });
});
