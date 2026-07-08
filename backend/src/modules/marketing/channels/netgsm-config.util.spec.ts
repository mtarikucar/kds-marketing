import { BadRequestException } from '@nestjs/common';
import { assertNetgsmSmsSecrets, assertNetgsmSmsPublicConfig } from './netgsm-config.util';

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

/**
 * `useLegacySend` lives on the channel's PUBLIC config (never secrets) and
 * routes `NetgsmSmsAdapter.send` between the legacy GET API and REST v2. This
 * validator only checks the TYPE — it never defaults or mutates the config
 * (the adapter treats anything other than `true` as v2, i.e. default false).
 */
describe('assertNetgsmSmsPublicConfig', () => {
  it('accepts an absent configPublic (v2 default applies downstream)', () => {
    expect(() => assertNetgsmSmsPublicConfig(undefined)).not.toThrow();
    expect(() => assertNetgsmSmsPublicConfig(null)).not.toThrow();
  });

  it('accepts a configPublic with no useLegacySend key', () => {
    expect(() => assertNetgsmSmsPublicConfig({ brandCode: 'ACME' })).not.toThrow();
  });

  it('accepts useLegacySend: true and useLegacySend: false', () => {
    expect(() => assertNetgsmSmsPublicConfig({ useLegacySend: true })).not.toThrow();
    expect(() => assertNetgsmSmsPublicConfig({ useLegacySend: false })).not.toThrow();
  });

  it('rejects a non-boolean useLegacySend (BadRequest)', () => {
    expect(() => assertNetgsmSmsPublicConfig({ useLegacySend: 'true' as any })).toThrow(
      BadRequestException,
    );
    expect(() => assertNetgsmSmsPublicConfig({ useLegacySend: 1 as any })).toThrow(/boolean/i);
    expect(() => assertNetgsmSmsPublicConfig({ useLegacySend: null as any })).toThrow(/boolean/i);
  });
});
