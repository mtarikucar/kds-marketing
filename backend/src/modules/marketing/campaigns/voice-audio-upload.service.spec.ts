import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { VoiceAudioUploadService } from './voice-audio-upload.service';

const WORKSPACE = 'ws-1';

function wavFile(overrides: Partial<{ originalname: string; mimetype: string; buffer: Buffer; size: number }> = {}) {
  const buffer = overrides.buffer ?? Buffer.from('RIFF....WAVEfmt ');
  return {
    originalname: 'greeting.wav',
    mimetype: 'audio/wav',
    buffer,
    size: buffer.length,
    ...overrides,
  };
}

describe('VoiceAudioUploadService.upload', () => {
  let prisma: { channel: { findFirst: jest.Mock } };
  let registry: { resolveConfig: jest.Mock };
  let voicesmsSend: { upload: jest.Mock };
  let svc: VoiceAudioUploadService;

  const resolvedConfig = { secrets: { usercode: 'u1', password: 'p1' }, public: {} };

  beforeEach(() => {
    prisma = { channel: { findFirst: jest.fn().mockResolvedValue({ id: 'ch-1' }) } };
    registry = { resolveConfig: jest.fn().mockReturnValue(resolvedConfig) };
    voicesmsSend = { upload: jest.fn().mockResolvedValue({ ok: true, audioid: 'aid-1', message: null }) };
    svc = new VoiceAudioUploadService(prisma as any, registry as any, voicesmsSend as any);
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it('accepts a wav ≤4MB, resolves creds from the ACTIVE SMS channel, and returns {audioid}', async () => {
    const file = wavFile();

    const out = await svc.upload(WORKSPACE, file);

    expect(out).toEqual({ audioid: 'aid-1' });
    expect(prisma.channel.findFirst).toHaveBeenCalledWith({ where: { workspaceId: WORKSPACE, type: 'SMS', status: 'ACTIVE' } });
    expect(registry.resolveConfig).toHaveBeenCalledWith({ id: 'ch-1' });
    expect(voicesmsSend.upload).toHaveBeenCalledWith({ usercode: 'u1', password: 'p1' }, file.buffer, 'greeting.wav');
  });

  it('falls back to a default filename when originalname is blank', async () => {
    const file = wavFile({ originalname: '' });
    await svc.upload(WORKSPACE, file);
    expect(voicesmsSend.upload).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'voice-campaign.wav');
  });

  it('tolerates a missing mimetype when the extension is .wav', async () => {
    const file = wavFile({ mimetype: undefined });
    await expect(svc.upload(WORKSPACE, file)).resolves.toEqual({ audioid: 'aid-1' });
  });

  // ── Reject BEFORE calling NetGSM ─────────────────────────────────────────

  it('rejects a missing file with 400 and never touches creds/NetGSM', async () => {
    await expect(svc.upload(WORKSPACE, undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.channel.findFirst).not.toHaveBeenCalled();
    expect(voicesmsSend.upload).not.toHaveBeenCalled();
  });

  it('rejects an empty buffer with 400', async () => {
    const file = wavFile({ buffer: Buffer.alloc(0) });
    await expect(svc.upload(WORKSPACE, file)).rejects.toBeInstanceOf(BadRequestException);
    expect(voicesmsSend.upload).not.toHaveBeenCalled();
  });

  it('rejects an oversize (>4MB) file with 400 and never calls NetGSM', async () => {
    const file = wavFile({ buffer: Buffer.alloc(4 * 1024 * 1024 + 1) });

    await expect(svc.upload(WORKSPACE, file)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.channel.findFirst).not.toHaveBeenCalled();
    expect(voicesmsSend.upload).not.toHaveBeenCalled();
  });

  it('rejects a non-wav extension with 400 and never calls NetGSM', async () => {
    const file = wavFile({ originalname: 'jingle.mp3', mimetype: 'audio/mpeg' });

    await expect(svc.upload(WORKSPACE, file)).rejects.toBeInstanceOf(BadRequestException);
    expect(voicesmsSend.upload).not.toHaveBeenCalled();
  });

  it('rejects a spoofed .wav extension carrying a non-wav mimetype with 400', async () => {
    const file = wavFile({ originalname: 'jingle.wav', mimetype: 'audio/mpeg' });

    await expect(svc.upload(WORKSPACE, file)).rejects.toBeInstanceOf(BadRequestException);
    expect(voicesmsSend.upload).not.toHaveBeenCalled();
  });

  // ── Creds resolution ──────────────────────────────────────────────────────

  it('fails closed with 503 when there is no ACTIVE SMS channel (voicesms shares its creds)', async () => {
    prisma.channel.findFirst.mockResolvedValue(null);
    const file = wavFile();

    await expect(svc.upload(WORKSPACE, file)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(voicesmsSend.upload).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the ACTIVE SMS channel has incomplete secrets', async () => {
    registry.resolveConfig.mockReturnValue({ secrets: { usercode: 'u1' }, public: {} });
    const file = wavFile();

    await expect(svc.upload(WORKSPACE, file)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(voicesmsSend.upload).not.toHaveBeenCalled();
  });

  // ── NetGSM outcome mapping ────────────────────────────────────────────────

  it('surfaces a NetGSM upload failure as a 400 carrying its message', async () => {
    voicesmsSend.upload.mockResolvedValue({ ok: false, audioid: null, message: 'NetGSM boş yanıt döndürdü.' });
    const file = wavFile();

    await expect(svc.upload(WORKSPACE, file)).rejects.toThrow('NetGSM boş yanıt döndürdü.');
  });

  it('surfaces a success code with no audioid as a 400 (nothing usable to hand back)', async () => {
    voicesmsSend.upload.mockResolvedValue({ ok: true, audioid: null, message: null });
    const file = wavFile();

    await expect(svc.upload(WORKSPACE, file)).rejects.toBeInstanceOf(BadRequestException);
  });
});
