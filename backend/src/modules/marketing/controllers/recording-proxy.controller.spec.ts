import { NotFoundException } from '@nestjs/common';
import { RecordingProxyController } from './recording-proxy.controller';
import { mintRecordingProxyToken } from '../telephony/recording-proxy-token.util';

/**
 * HIGH fix round 1 — this route is the ONLY thing the browser ever sees for
 * a call recording now (never R2's public URL). Coverage: token
 * verification gates everything before any DB/R2 work, a missing storage key
 * still 404s (provider-url-only calls aren't proxied — see the class
 * docstring), and the happy path sets sensible streaming headers.
 */
describe('RecordingProxyController', () => {
  const WS = 'ws-1';
  const CALL = 'call-1';

  beforeAll(() => {
    process.env.MARKETING_SECRET_KEY = Buffer.from('k'.repeat(32)).toString('base64');
  });
  afterAll(() => {
    delete process.env.MARKETING_SECRET_KEY;
  });

  function makeController() {
    const prisma = { salesCall: { findFirst: jest.fn() } };
    const r2 = { getObjectStream: jest.fn() };
    const ctrl = new RecordingProxyController(prisma as any, r2 as any);
    return { prisma, r2, ctrl };
  }

  function fakeRes() {
    const headers: Record<string, string> = {};
    return {
      headersSent: false,
      setHeader: jest.fn((k: string, v: string) => {
        headers[k] = v;
      }),
      status: jest.fn().mockReturnThis(),
      end: jest.fn(),
      headers,
    } as any;
  }

  it('404s a bad/forged token before touching prisma or R2', async () => {
    const { prisma, r2, ctrl } = makeController();
    const res = fakeRes();

    await expect(ctrl.stream(WS, CALL, 'garbage', res)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.salesCall.findFirst).not.toHaveBeenCalled();
    expect(r2.getObjectStream).not.toHaveBeenCalled();
  });

  it('404s an expired token', async () => {
    const { prisma, ctrl } = makeController();
    const expired = mintRecordingProxyToken(WS, CALL, -1);
    const res = fakeRes();

    await expect(ctrl.stream(WS, CALL, expired, res)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.salesCall.findFirst).not.toHaveBeenCalled();
  });

  it("404s a token minted for a DIFFERENT call (can't be replayed cross-call)", async () => {
    const { prisma, ctrl } = makeController();
    const token = mintRecordingProxyToken(WS, 'other-call');
    const res = fakeRes();

    await expect(ctrl.stream(WS, CALL, token, res)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.salesCall.findFirst).not.toHaveBeenCalled();
  });

  it('404s when the call has no recordingStorageKey (not-yet-ingested — provider url is not proxied here)', async () => {
    const { prisma, ctrl } = makeController();
    prisma.salesCall.findFirst.mockResolvedValue({ recordingStorageKey: null });
    const token = mintRecordingProxyToken(WS, CALL);
    const res = fakeRes();

    await expect(ctrl.stream(WS, CALL, token, res)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.salesCall.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CALL, workspaceId: WS } }),
    );
  });

  it('404s when the call row is not found (cross-workspace / unknown id)', async () => {
    const { prisma, ctrl } = makeController();
    prisma.salesCall.findFirst.mockResolvedValue(null);
    const token = mintRecordingProxyToken(WS, CALL);
    const res = fakeRes();

    await expect(ctrl.stream(WS, CALL, token, res)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('404s when R2 fetch fails (misconfigured / deleted object) rather than 500ing', async () => {
    const { prisma, r2, ctrl } = makeController();
    prisma.salesCall.findFirst.mockResolvedValue({ recordingStorageKey: 'netgsm-recordings/ws-1/call-1.mp3' });
    r2.getObjectStream.mockRejectedValue(new Error('R2 down'));
    const token = mintRecordingProxyToken(WS, CALL);
    const res = fakeRes();

    await expect(ctrl.stream(WS, CALL, token, res)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('streams the object with audio content-type, length, and a private no-store cache header', async () => {
    const { prisma, r2, ctrl } = makeController();
    prisma.salesCall.findFirst.mockResolvedValue({ recordingStorageKey: 'netgsm-recordings/ws-1/call-1.mp3' });
    const pipeMock = jest.fn();
    r2.getObjectStream.mockResolvedValue({
      body: { pipe: pipeMock, on: jest.fn() },
      contentType: 'audio/mpeg',
      contentLength: 4096,
    });
    const token = mintRecordingProxyToken(WS, CALL);
    const res = fakeRes();

    await ctrl.stream(WS, CALL, token, res);

    expect(r2.getObjectStream).toHaveBeenCalledWith('netgsm-recordings/ws-1/call-1.mp3');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'audio/mpeg');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Length', '4096');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(pipeMock).toHaveBeenCalledWith(res);
  });

  it('defaults to audio/mpeg content-type when R2 reports none', async () => {
    const { prisma, r2, ctrl } = makeController();
    prisma.salesCall.findFirst.mockResolvedValue({ recordingStorageKey: 'k' });
    r2.getObjectStream.mockResolvedValue({ body: { pipe: jest.fn(), on: jest.fn() } });
    const token = mintRecordingProxyToken(WS, CALL);
    const res = fakeRes();

    await ctrl.stream(WS, CALL, token, res);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'audio/mpeg');
    expect(res.setHeader).not.toHaveBeenCalledWith('Content-Length', expect.anything());
  });
});
