import { netgsmErrorMessage, NetgsmError } from './netgsm-error.map';

describe('netgsm error map', () => {
  it('maps the documented codes', () => {
    expect(netgsmErrorMessage('30')).toMatch(/kimlik|IP/i);
    expect(netgsmErrorMessage('40')).toMatch(/başlık/i);
    expect(netgsmErrorMessage('60')).toMatch(/paket|yetki/i);
    expect(netgsmErrorMessage('80')).toMatch(/hız|limit/i);
  });
  it('falls back for unknown codes', () => {
    expect(netgsmErrorMessage('999')).toContain('999');
  });
  it('NetgsmError carries the code', () => {
    const e = new NetgsmError('30');
    expect(e.code).toBe('30');
    expect(e.message).toBe(netgsmErrorMessage('30'));
  });
});
