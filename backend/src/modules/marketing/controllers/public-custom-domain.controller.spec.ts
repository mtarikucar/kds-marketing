import { PublicCustomDomainController } from './public-custom-domain.controller';

/**
 * Caddy on-demand-TLS authorization gate (Epic 13). The edge proxy asks before
 * minting a cert for an inbound host; we must answer 200 ONLY for a domain the
 * service authorizes (VERIFIED), and 404 for everything else — otherwise the
 * edge could be tricked into issuing certs for arbitrary hostnames. A service
 * error must fail CLOSED (404), never throw.
 */
describe('PublicCustomDomainController (Caddy tls-ask gate)', () => {
  let domains: { tlsAsk: jest.Mock };
  let ctrl: PublicCustomDomainController;

  const res = () => {
    const r: any = {};
    r.status = jest.fn().mockReturnValue(r);
    r.type = jest.fn().mockReturnValue(r);
    r.send = jest.fn().mockReturnValue(r);
    return r;
  };

  beforeEach(() => {
    domains = { tlsAsk: jest.fn() };
    ctrl = new PublicCustomDomainController(domains as any);
  });

  it('200 "OK" for an authorized (VERIFIED) domain', async () => {
    domains.tlsAsk.mockResolvedValue(true);
    const r = res();
    await ctrl.tlsAsk('shop.acme.com', r);
    expect(domains.tlsAsk).toHaveBeenCalledWith('shop.acme.com');
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.send).toHaveBeenCalledWith('OK');
  });

  it('404 "no" for an unauthorized host (edge must NOT mint a cert)', async () => {
    domains.tlsAsk.mockResolvedValue(false);
    const r = res();
    await ctrl.tlsAsk('attacker.example', r);
    expect(r.status).toHaveBeenCalledWith(404);
    expect(r.send).toHaveBeenCalledWith('no');
  });

  it('fails CLOSED (404) when the service throws — never 500s the edge', async () => {
    domains.tlsAsk.mockRejectedValue(new Error('db down'));
    const r = res();
    await ctrl.tlsAsk('shop.acme.com', r);
    expect(r.status).toHaveBeenCalledWith(404);
    expect(r.send).toHaveBeenCalledWith('no');
  });
});
