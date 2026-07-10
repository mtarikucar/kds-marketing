import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { FaxSendService } from './fax-send.service';

const WORKSPACE = 'ws-1';

function pdfFile(overrides: Partial<{ originalname: string; mimetype: string; buffer: Buffer; size: number }> = {}) {
  const buffer = overrides.buffer ?? Buffer.from('%PDF-1.4 fake pdf body');
  return {
    originalname: 'offer.pdf',
    mimetype: 'application/pdf',
    buffer,
    size: buffer.length,
    ...overrides,
  };
}

describe('FaxSendService.send', () => {
  let prisma: { channel: { findFirst: jest.Mock } };
  let registry: { resolveConfig: jest.Mock };
  let faxClient: { send: jest.Mock };
  let svc: FaxSendService;

  const resolvedConfig = { secrets: { usercode: 'u1', password: 'p1' }, public: {} };

  beforeEach(() => {
    prisma = { channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch-1' }) } };
    registry = { resolveConfig: jest.fn().mockReturnValue(resolvedConfig) };
    faxClient = { send: jest.fn().mockResolvedValue({ ok: true, jobId: 'job-1', message: null, code: '00', retriable: false, transport: false }) };
    svc = new FaxSendService(prisma as any, registry as any, faxClient as any);
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it('accepts a PDF ≤5MB, resolves creds from the ACTIVE SMS channel, and returns {jobId}', async () => {
    const file = pdfFile();

    const out = await svc.send(WORKSPACE, file, { to: '905551112233' });

    expect(out).toEqual({ jobId: 'job-1' });
    expect(prisma.channel.findFirst).toHaveBeenCalledWith({ where: { workspaceId: WORKSPACE, type: 'SMS', status: 'ACTIVE' } });
    expect(registry.resolveConfig).toHaveBeenCalledWith({ id: 'ch-1' });
    expect(faxClient.send).toHaveBeenCalledWith(
      { usercode: 'u1', password: 'p1' },
      { to: '905551112233', document: file.buffer, filename: 'offer.pdf', header: undefined },
    );
  });

  it('trims and forwards an optional header', async () => {
    const file = pdfFile();
    await svc.send(WORKSPACE, file, { to: '905551112233', header: '  ACME A.Ş.  ' });
    expect(faxClient.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ header: 'ACME A.Ş.' }));
  });

  it('falls back to a default filename when originalname is blank', async () => {
    const file = pdfFile({ originalname: '' });
    await svc.send(WORKSPACE, file, { to: '905551112233' });
    expect(faxClient.send).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ filename: 'document.pdf' }));
  });

  it('tolerates a missing mimetype when the extension is .pdf', async () => {
    const file = pdfFile({ mimetype: undefined });
    await expect(svc.send(WORKSPACE, file, { to: '905551112233' })).resolves.toEqual({ jobId: 'job-1' });
  });

  // ── Reject BEFORE calling NetGSM ─────────────────────────────────────────

  it('rejects a missing file with 400 and never touches creds/NetGSM', async () => {
    await expect(svc.send(WORKSPACE, undefined, { to: '905551112233' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.channel.findFirst).not.toHaveBeenCalled();
    expect(faxClient.send).not.toHaveBeenCalled();
  });

  it('rejects an empty buffer with 400', async () => {
    const file = pdfFile({ buffer: Buffer.alloc(0) });
    await expect(svc.send(WORKSPACE, file, { to: '905551112233' })).rejects.toBeInstanceOf(BadRequestException);
    expect(faxClient.send).not.toHaveBeenCalled();
  });

  it('rejects an oversize (>5MB) file with 400 and never calls NetGSM', async () => {
    const file = pdfFile({ buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });

    await expect(svc.send(WORKSPACE, file, { to: '905551112233' })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.channel.findFirst).not.toHaveBeenCalled();
    expect(faxClient.send).not.toHaveBeenCalled();
  });

  it('rejects a non-pdf extension with 400 and never calls NetGSM', async () => {
    const file = pdfFile({ originalname: 'photo.png', mimetype: 'image/png' });

    await expect(svc.send(WORKSPACE, file, { to: '905551112233' })).rejects.toBeInstanceOf(BadRequestException);
    expect(faxClient.send).not.toHaveBeenCalled();
  });

  it('rejects a magic-byte spoof (.pdf name + application/pdf mimetype but non-%PDF bytes, e.g. a PE/exe) BEFORE calling NetGSM', async () => {
    // Both client-controlled fields say pdf; the actual bytes are a PE header.
    const file = pdfFile({ originalname: 'payload.pdf', mimetype: 'application/pdf', buffer: Buffer.from('MZ\x90\x00\x03\x00\x00\x00PE\x00\x00') });
    await expect(svc.send(WORKSPACE, file, { to: '905551112233' })).rejects.toBeInstanceOf(BadRequestException);
    expect(faxClient.send).not.toHaveBeenCalled();
  });

  it('rejects a spoofed .pdf extension carrying a non-pdf mimetype with 400', async () => {
    const file = pdfFile({ originalname: 'offer.pdf', mimetype: 'image/png' });

    await expect(svc.send(WORKSPACE, file, { to: '905551112233' })).rejects.toBeInstanceOf(BadRequestException);
    expect(faxClient.send).not.toHaveBeenCalled();
  });

  it('rejects a missing/blank recipient with 400 and never calls NetGSM', async () => {
    const file = pdfFile();
    await expect(svc.send(WORKSPACE, file, { to: '   ' })).rejects.toBeInstanceOf(BadRequestException);
    expect(faxClient.send).not.toHaveBeenCalled();
  });

  // ── Creds resolution ──────────────────────────────────────────────────────

  it('fails closed with 503 when there is no ACTIVE SMS channel (fax shares its creds)', async () => {
    prisma.channel.findFirst.mockResolvedValue(null);
    const file = pdfFile();

    await expect(svc.send(WORKSPACE, file, { to: '905551112233' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(faxClient.send).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the ACTIVE SMS channel has incomplete secrets', async () => {
    registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u1' }, public: {} });
    const file = pdfFile();

    await expect(svc.send(WORKSPACE, file, { to: '905551112233' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(faxClient.send).not.toHaveBeenCalled();
  });

  // ── NetGSM outcome mapping ────────────────────────────────────────────────

  it('surfaces a NetGSM send failure as a 400 carrying its message', async () => {
    faxClient.send.mockResolvedValue({ ok: false, jobId: null, message: 'NetGSM boş yanıt döndürdü.', code: '', retriable: false, transport: false });
    const file = pdfFile();

    await expect(svc.send(WORKSPACE, file, { to: '905551112233' })).rejects.toThrow('NetGSM boş yanıt döndürdü.');
  });

  it('surfaces a success code with no jobId as a 400 (nothing usable to hand back)', async () => {
    faxClient.send.mockResolvedValue({ ok: true, jobId: null, message: null, code: '00', retriable: false, transport: false });
    const file = pdfFile();

    await expect(svc.send(WORKSPACE, file, { to: '905551112233' })).rejects.toBeInstanceOf(BadRequestException);
  });
});
