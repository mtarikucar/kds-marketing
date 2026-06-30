import { BadRequestException } from '@nestjs/common';
import { assertTiktokDmSecrets } from './tiktok-config.util';

/**
 * TikTok DM channel credential validation. Only requires an accessToken (the
 * TikTok-for-Business messaging token). Failing at save-time with a clear
 * message beats discovering it as an opaque API error on the first send.
 */
describe('assertTiktokDmSecrets', () => {
  it('accepts a present, non-blank access token (no throw)', () => {
    expect(() =>
      assertTiktokDmSecrets({ accessToken: 'tok_abc123' }),
    ).not.toThrow();
  });

  it('rejects missing accessToken (throws BadRequestException)', () => {
    expect(() => assertTiktokDmSecrets({})).toThrow(BadRequestException);
    expect(() => assertTiktokDmSecrets(undefined)).toThrow(BadRequestException);
  });

  it('rejects blank accessToken (throws BadRequestException)', () => {
    expect(() => assertTiktokDmSecrets({ accessToken: '' })).toThrow(BadRequestException);
    expect(() => assertTiktokDmSecrets({ accessToken: '   ' })).toThrow(BadRequestException);
  });

  it('error message mentions accessToken', () => {
    expect(() => assertTiktokDmSecrets({})).toThrow(/accessToken/i);
  });
});
