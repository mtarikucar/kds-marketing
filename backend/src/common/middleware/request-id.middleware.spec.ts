import { requestIdMiddleware } from './request-id.middleware';

function mk(headers: Record<string, unknown> = {}) {
  const req: any = { headers };
  const setHeader = jest.fn();
  const res: any = { setHeader };
  const next = jest.fn();
  return { req, res, next, setHeader };
}

describe('requestIdMiddleware', () => {
  it('mints a uuid when no inbound id is present', () => {
    const { req, res, next, setHeader } = mk();
    requestIdMiddleware(req, res, next);
    expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(req.requestId).toBe(req.id);
    expect(setHeader).toHaveBeenCalledWith('X-Request-ID', req.id);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('honors a safe inbound id for cross-hop correlation', () => {
    const { req, res, next, setHeader } = mk({ 'x-request-id': 'trace_abc-123' });
    requestIdMiddleware(req, res, next);
    expect(req.id).toBe('trace_abc-123');
    expect(setHeader).toHaveBeenCalledWith('X-Request-ID', 'trace_abc-123');
  });

  it('takes the first value when the header arrives as an array', () => {
    const { req } = mk({ 'x-request-id': ['first-id', 'second-id'] });
    const res: any = { setHeader: jest.fn() };
    requestIdMiddleware(req, res, jest.fn());
    expect(req.id).toBe('first-id');
  });

  it('rejects a malformed inbound id (header injection / unbounded key) and mints its own', () => {
    const { req } = mk({ 'x-request-id': 'bad id with spaces' });
    const res: any = { setHeader: jest.fn() };
    requestIdMiddleware(req, res, jest.fn());
    expect(req.id).not.toBe('bad id with spaces');
    expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects an over-long inbound id', () => {
    const { req } = mk({ 'x-request-id': 'a'.repeat(200) });
    const res: any = { setHeader: jest.fn() };
    requestIdMiddleware(req, res, jest.fn());
    expect(req.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
