import { McpController } from './mcp.controller';

describe('McpController', () => {
  it('rejects a request with no bearer token', async () => {
    const factory = { build: jest.fn() } as any;
    const verifier = { verifyAccessToken: jest.fn() } as any;
    const controller = new McpController(factory, verifier);
    const res: any = { status: jest.fn().mockReturnThis(), setHeader: jest.fn(), json: jest.fn(), end: jest.fn() };
    await controller.handle({ headers: {}, method: 'POST', body: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(verifier.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('rejects an invalid bearer token without building a server', async () => {
    const factory = { build: jest.fn() } as any;
    const verifier = { verifyAccessToken: jest.fn().mockRejectedValue(new Error('bad')) } as any;
    const controller = new McpController(factory, verifier);
    const res: any = { status: jest.fn().mockReturnThis(), setHeader: jest.fn(), json: jest.fn(), end: jest.fn() };
    await controller.handle({ headers: { authorization: 'Bearer nope' }, method: 'POST', body: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(factory.build).not.toHaveBeenCalled();
  });
});
