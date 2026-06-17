import { BadRequestException } from '@nestjs/common';
import { assertNetgsmSmsSecrets } from './netgsm-config.util';

/**
 * SMS channel credential validation. NetGSM needs usercode + (API) password +
 * an İYS-approved sender header that is 3–11 characters. We validate at
 * save-time so a misconfigured channel fails loudly with an actionable message
 * rather than silently returning a NetGSM error code on the first send.
 */
describe('assertNetgsmSmsSecrets', () => {
  it('accepts complete secrets with a 3–11 char header', () => {
    expect(() =>
      assertNetgsmSmsSecrets({ usercode: 'u', password: 'p', msgheader: 'ACME' }),
    ).not.toThrow();
  });

  it('rejects missing usercode / password / msgheader (BadRequest)', () => {
    expect(() => assertNetgsmSmsSecrets({ password: 'p', msgheader: 'ACME' })).toThrow(
      BadRequestException,
    );
    expect(() => assertNetgsmSmsSecrets({ usercode: 'u', password: 'p', msgheader: 'ACME' })).not.toThrow();
    expect(() => assertNetgsmSmsSecrets({ usercode: 'u', msgheader: 'ACME' })).toThrow(/password/i);
    expect(() => assertNetgsmSmsSecrets({ usercode: 'u', password: 'p' })).toThrow(/header/i);
  });

  it('rejects a header shorter than 3 or longer than 11 characters', () => {
    expect(() => assertNetgsmSmsSecrets({ usercode: 'u', password: 'p', msgheader: 'AB' })).toThrow(
      /3.*11|header/i,
    );
    expect(() =>
      assertNetgsmSmsSecrets({ usercode: 'u', password: 'p', msgheader: 'ABCDEFGHIJKL' }),
    ).toThrow(/3.*11|header/i);
  });

  it('trims the header before length-checking', () => {
    expect(() => assertNetgsmSmsSecrets({ usercode: 'u', password: 'p', msgheader: '  AB  ' })).toThrow();
    expect(() =>
      assertNetgsmSmsSecrets({ usercode: 'u', password: 'p', msgheader: '  ACME  ' }),
    ).not.toThrow();
  });

  it('treats blank/whitespace values as missing', () => {
    expect(() =>
      assertNetgsmSmsSecrets({ usercode: '   ', password: 'p', msgheader: 'ACME' }),
    ).toThrow(/usercode/i);
  });
});
