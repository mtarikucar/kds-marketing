import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { NetgsmIvrController } from './netgsm-ivr.controller';

function makeController(reply: any = { status: 'success', result: '1', data: 'merhaba' }) {
  const service = { handle: jest.fn().mockResolvedValue(reply) };
  const controller = new NetgsmIvrController(service as any);
  return { service, controller };
}

const OLD = process.env;

describe('NetgsmIvrController', () => {
  beforeEach(() => { process.env = { ...OLD, NETGSM_IVR_TOKEN: 'secret-token' }; });
  afterAll(() => { process.env = OLD; });

  it('inert: NotFoundException when NETGSM_IVR_TOKEN unset', async () => {
    delete process.env.NETGSM_IVR_TOKEN;
    const { controller, service } = makeController();
    await expect(controller.webhook('secret-token', {}, {})).rejects.toBeInstanceOf(NotFoundException);
    expect(service.handle).not.toHaveBeenCalled();
  });

  it('403 ForbiddenException on token mismatch', async () => {
    const { controller, service } = makeController();
    await expect(controller.webhook('wrong-token', {}, {})).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.handle).not.toHaveBeenCalled();
  });

  it('403 on length-mismatched token (timing-safe length guard)', async () => {
    const { controller } = makeController();
    await expect(controller.webhook('x', {}, {})).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('200 + service JSON on valid token (merges query + body, body wins)', async () => {
    const { controller, service } = makeController({ status: 'success', result: '1', data: 'ok' });
    const query = { arayan_no: '0533', santral_no: '0850', arama_id: 'from-query' };
    const body = { arama_id: 'from-body', tus_bilgisi: '1' };

    const r = await controller.webhook('secret-token', query, body);

    expect(r).toEqual({ status: 'success', result: '1', data: 'ok' });
    const passed = service.handle.mock.calls[0][0];
    expect(passed.arayan_no).toBe('0533'); // from query
    expect(passed.arama_id).toBe('from-body'); // body wins
    expect(passed.tus_bilgisi).toBe('1');
  });
});
