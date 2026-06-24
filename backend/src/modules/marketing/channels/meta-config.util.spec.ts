import { BadRequestException } from '@nestjs/common';
import { assertMetaSecrets, isMetaChannelType } from './meta-config.util';

describe('isMetaChannelType', () => {
  it('recognizes the three Meta messaging types only', () => {
    expect(isMetaChannelType('WHATSAPP')).toBe(true);
    expect(isMetaChannelType('MESSENGER')).toBe(true);
    expect(isMetaChannelType('INSTAGRAM')).toBe(true);
    expect(isMetaChannelType('SMS')).toBe(false);
    expect(isMetaChannelType('WEBCHAT')).toBe(false);
  });
});

describe('assertMetaSecrets', () => {
  it('WHATSAPP requires accessToken + phoneNumberId', () => {
    expect(() => assertMetaSecrets('WHATSAPP', { accessToken: 't' })).toThrow(BadRequestException);
    expect(() => assertMetaSecrets('WHATSAPP', { phoneNumberId: '1' })).toThrow(BadRequestException);
    expect(() => assertMetaSecrets('WHATSAPP', { accessToken: 't', phoneNumberId: '1' })).not.toThrow();
  });

  it('MESSENGER/INSTAGRAM require a pageAccessToken', () => {
    expect(() => assertMetaSecrets('MESSENGER', {})).toThrow(BadRequestException);
    expect(() => assertMetaSecrets('INSTAGRAM', { pageAccessToken: '' })).toThrow(BadRequestException);
    expect(() => assertMetaSecrets('MESSENGER', { pageAccessToken: 'pat' })).not.toThrow();
    expect(() => assertMetaSecrets('INSTAGRAM', { pageAccessToken: 'pat' })).not.toThrow();
  });

  it('treats whitespace-only secrets as missing', () => {
    expect(() => assertMetaSecrets('WHATSAPP', { accessToken: '  ', phoneNumberId: '1' })).toThrow(
      BadRequestException,
    );
  });

  it('is a no-op for non-Meta types', () => {
    expect(() => assertMetaSecrets('SMS', {})).not.toThrow();
  });
});
