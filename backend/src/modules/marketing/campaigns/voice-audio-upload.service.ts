import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { VoicesmsSendClient } from '../../netgsm/voice/voicesms-send.client';

/** NetGSM's documented voice-upload cap — mirrors VoicesmsSendClient.upload's
 *  own constant, duplicated here so this endpoint can reject an oversize file
 *  with a clean 400 BEFORE the client (and therefore NetGSM) is ever touched. */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** Accepted `Content-Type`s for a .wav upload. A missing/absent mimetype is
 *  tolerated (some browsers/proxies omit or mislabel it for wav) as long as
 *  the filename extension is `.wav`; a PRESENT mimetype that isn't wav-ish is
 *  always rejected, even if the extension was spoofed to `.wav`. */
const WAV_MIME_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']);

/** The minimal Multer file shape this service needs — matches the `any` the
 *  controller's `@UploadedFile()` hands over (mirrors MarketingMediaController/
 *  SocialPlannerController's own untyped `file: any` idiom for the same reason:
 *  `@types/multer`'s `Express.Multer.File` isn't globally augmented here). */
export interface UploadedWavFile {
  originalname?: string;
  mimetype?: string;
  buffer?: Buffer;
  size?: number;
}

/**
 * `POST /marketing/campaigns/voice/audio` business logic (NetGSM Phase 5 Task 4):
 * accepts a multipart .wav, rejects anything non-wav or over NetGSM's 4MB cap
 * BEFORE ever calling out, resolves this workspace's voice creds (voicesms/send
 * and voicesms/upload authenticate with the SAME usercode/password as the SMS
 * REST APIs — mirrors `CampaignSenderService.sendVoice`'s own creds resolution
 * exactly: the ACTIVE SMS channel's account, there is no separate "VOICE
 * channel" row for this), and forwards to `VoicesmsSendClient.upload`.
 */
@Injectable()
export class VoiceAudioUploadService {
  private readonly logger = new Logger(VoiceAudioUploadService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly voicesmsSend: VoicesmsSendClient,
  ) {}

  async upload(workspaceId: string, file: UploadedWavFile | undefined): Promise<{ audioid: string }> {
    this.assertWav(file);
    const creds = await this.resolveCreds(workspaceId);
    const name = (file!.originalname ?? '').trim() || 'voice-campaign.wav';
    const result = await this.voicesmsSend.upload(creds, file!.buffer as Buffer, name);
    if (!result.ok || !result.audioid) {
      throw new BadRequestException(result.message || 'NetGSM ses dosyasını işleyemedi.');
    }
    return { audioid: result.audioid };
  }

  /** Reject a missing/empty file, an oversize file (>4MB), or a non-wav file —
   *  all BEFORE `resolveCreds`/`voicesmsSend.upload` are ever reached, so a
   *  malformed request never burns a network round-trip to NetGSM. */
  private assertWav(file: UploadedWavFile | undefined): void {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw new BadRequestException('Ses dosyası bulunamadı.');
    }
    const size = typeof file.size === 'number' ? file.size : file.buffer.length;
    if (file.buffer.length > MAX_UPLOAD_BYTES || size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException("Ses dosyası NetGSM sınırı olan 4MB'ı aşıyor.");
    }
    // Content-type AND extension are both client-controlled and spoofable, so
    // neither is trusted alone — the authoritative check is the actual bytes:
    // a real WAV is a RIFF container tagged "WAVE" (bytes 0-3 "RIFF", 8-11
    // "WAVE"). We require that magic header AND a sane extension/mimetype, so a
    // .exe relabelled `audio/wav` (or a .wav-named PE file) is rejected here,
    // before the workspace's real NetGSM creds ever forward it.
    // Magic bytes are the authority; a BLANK ext or mime is tolerated (some
    // browsers/proxies omit them for wav), but a POSITIVELY-WRONG ext (.mp3) or
    // mime (audio/mpeg) is still rejected.
    const name = (file.originalname ?? '').toLowerCase().trim();
    const mime = (file.mimetype ?? '').toLowerCase().trim();
    const extOk = name === '' || name.endsWith('.wav');
    const mimeOk = mime === '' || WAV_MIME_TYPES.has(mime);
    const b = file.buffer;
    const magicOk =
      b.length >= 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WAVE';
    if (!extOk || !mimeOk || !magicOk) {
      throw new BadRequestException('Yalnızca geçerli .wav ses dosyaları kabul edilir.');
    }
  }

  /** Same resolution as `CampaignSenderService.sendVoice` — reuse the
   *  workspace's ACTIVE SMS channel's usercode/password (voicesms has no
   *  separate credential surface). No ACTIVE SMS channel, or one with
   *  incomplete secrets, fails closed rather than guessing. */
  private async resolveCreds(workspaceId: string): Promise<{ usercode: string; password: string }> {
    const ch = await this.prisma.channel.findFirst({ where: { workspaceId, type: 'SMS', status: 'ACTIVE' } });
    const resolved = ch ? this.registry.resolveConfig(ch) : null;
    const usercode = resolved?.secrets?.usercode;
    const password = resolved?.secrets?.password;
    if (!usercode || !password) {
      throw new ServiceUnavailableException(
        'Sesli kampanya için NetGSM hesabı yapılandırılmamış (aktif bir SMS kanalı gerekli).',
      );
    }
    return { usercode, password };
  }
}
