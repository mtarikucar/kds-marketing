import { JsonLogger } from './json-logger';
import { runWithRequestContext } from './request-context';

/**
 * The structured logger is the observability spine: a log line is only useful
 * for incident triage if it (a) is machine-parseable and (b) carries the
 * correlation id of the request that produced it. These tests pin both.
 */
describe('JsonLogger (LOG_FORMAT=json)', () => {
  let writes: string[];
  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;
  const prevFormat = process.env.LOG_FORMAT;

  beforeEach(() => {
    process.env.LOG_FORMAT = 'json';
    writes = [];
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: any) => {
        writes.push(String(chunk));
        return true;
      });
    stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: any) => {
        writes.push(String(chunk));
        return true;
      });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    if (prevFormat === undefined) delete process.env.LOG_FORMAT;
    else process.env.LOG_FORMAT = prevFormat;
  });

  it('emits one JSON object per line with level, context and message', () => {
    new JsonLogger().log('hello', 'BootService');

    expect(writes).toHaveLength(1);
    expect(writes[0].endsWith('\n')).toBe(true);
    const parsed = JSON.parse(writes[0]);
    expect(parsed).toMatchObject({
      level: 'log',
      context: 'BootService',
      message: 'hello',
    });
    expect(typeof parsed.time).toBe('string');
  });

  it('stamps the active requestId from AsyncLocalStorage', () => {
    const logger = new JsonLogger();
    runWithRequestContext({ requestId: 'req-abc-123' }, () => {
      logger.log('inside a request', 'SomeService');
    });
    expect(JSON.parse(writes[0]).requestId).toBe('req-abc-123');
  });

  it('omits requestId outside any request scope', () => {
    new JsonLogger().log('background job');
    expect(JSON.parse(writes[0]).requestId).toBeUndefined();
  });

  it('routes errors to stderr and keeps the stack trace under `trace`', () => {
    const err = new Error('boom');
    new JsonLogger().error(err.message, err.stack, 'Worker');
    const parsed = JSON.parse(writes[0]);
    expect(parsed.level).toBe('error');
    expect(parsed.context).toBe('Worker');
    expect(parsed.message).toBe('boom');
    expect(String(parsed.trace)).toContain('Error: boom');
  });

  it('treats a 2-arg error(message, context) call as context, not a stack', () => {
    new JsonLogger().error('denied', 'AuthGuard');
    const parsed = JSON.parse(writes[0]);
    expect(parsed.context).toBe('AuthGuard');
    expect(parsed.trace).toBeUndefined();
  });
});
