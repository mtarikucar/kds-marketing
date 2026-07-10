import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { ChannelAdapterRegistry } from '../channels/channel-adapter.registry';
import { FaxClient } from '../../netgsm/fax/fax.client';

/** Sane pre-flight cap for a faxed PDF — rejected here BEFORE ever touching
 *  NetGSM. NetGSM's own documented fax-size ceiling is unconfirmed pending a
 *  live account; this is a conservative, product-level limit (mirrors
 *  `VoiceAudioUploadService`'s own MAX_UPLOAD_BYTES pre-flight cap for .wav). */
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** Accepted `Content-Type`s for a PDF upload. A missing/absent mimetype is
 *  tolerated (some browsers/proxies omit or mislabel it) as long as the
 *  filename extension is `.pdf`; a PRESENT mimetype that isn't PDF-ish is
 *  always rejected, even if the extension was spoofed to `.pdf`. */
const PDF_MIME_TYPES = new Set(['application/pdf']);

/** The minimal Multer file shape this service needs — matches the `any` the
 *  controller's `@UploadedFile()` hands over (mirrors `VoiceAudioUploadService`'s
 *  own `UploadedWavFile`/MarketingMediaController's untyped `file: any` idiom:
 *  `@types/multer`'s `Express.Multer.File` isn't globally augmented here). */
export interface UploadedPdfFile {
  originalname?: string;
  mimetype?: string;
  buffer?: Buffer;
  size?: number;
}

export interface FaxSendParams {
  to: string;
  header?: string;
}

/**
 * `POST /marketing/fax/send` business logic (NetGSM Phase 6 Task 1): accepts
 * a multipart PDF, rejects anything non-PDF or over a ~5MB sanity cap BEFORE
 * ever calling out (mirrors `VoiceAudioUploadService`'s RIFF/WAVE magic-byte
 * guard, swapped for the PDF `%PDF` signature), resolves this workspace's fax
 * creds (`/fax/send` authenticates with the SAME usercode/password as the SMS
 * REST APIs and the voice-campaign surfaces — mirrors
 * `VoiceAudioUploadService.resolveCreds` exactly: the ACTIVE SMS channel's
 * account, there is no separate "fax channel" row for this), and forwards to
 * `FaxClient.send`.
 */
@Injectable()
export class FaxSendService {
  private readonly logger = new Logger(FaxSendService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly faxClient: FaxClient,
  ) {}

  async send(
    workspaceId: string,
    file: UploadedPdfFile | undefined,
    params: FaxSendParams,
  ): Promise<{ jobId: string }> {
    this.assertPdf(file);
    const to = (params.to ?? '').trim();
    if (!to) throw new BadRequestException('Alıcı faks numarası gerekli.');
    const creds = await this.resolveCreds(workspaceId);
    const filename = (file!.originalname ?? '').trim() || 'document.pdf';
    const header = params.header?.trim() || undefined;
    const result = await this.faxClient.send(creds, {
      to,
      document: file!.buffer as Buffer,
      filename,
      header,
    });
    if (!result.ok || !result.jobId) {
      throw new BadRequestException(result.message || 'NetGSM faks isteğini işleyemedi.');
    }
    return { jobId: result.jobId };
  }

  /** Reject a missing/empty file, an oversize file (>5MB), or a non-PDF file —
   *  all BEFORE `resolveCreds`/`faxClient.send` are ever reached, so a
   *  malformed request never burns a network round-trip (or a billed fax) to
   *  NetGSM. */
  private assertPdf(file: UploadedPdfFile | undefined): void {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw new BadRequestException('Fakslanacak belge bulunamadı.');
    }
    const size = typeof file.size === 'number' ? file.size : file.buffer.length;
    if (file.buffer.length > MAX_DOCUMENT_BYTES || size > MAX_DOCUMENT_BYTES) {
      throw new BadRequestException('Belge izin verilen 5MB sınırını aşıyor.');
    }
    // Content-type AND extension are both client-controlled and spoofable, so
    // neither is trusted alone — the authoritative check is the actual bytes:
    // a real PDF starts with the "%PDF" magic header. We require that magic
    // header AND a sane extension/mimetype, so a .exe relabelled
    // `application/pdf` (or a .pdf-named PE file) is rejected here, before the
    // workspace's real NetGSM creds ever forward it. Magic bytes are the
    // authority; a BLANK ext or mime is tolerated (some browsers/proxies omit
    // them), but a POSITIVELY-WRONG ext (.exe) or mime (application/x-msdos)
    // is still rejected.
    const name = (file.originalname ?? '').toLowerCase().trim();
    const mime = (file.mimetype ?? '').toLowerCase().trim();
    const extOk = name === '' || name.endsWith('.pdf');
    const mimeOk = mime === '' || PDF_MIME_TYPES.has(mime);
    const b = file.buffer;
    const magicOk = b.length >= 4 && b.toString('ascii', 0, 4) === '%PDF';
    if (!extOk || !mimeOk || !magicOk) {
      throw new BadRequestException('Yalnızca geçerli PDF belgeleri kabul edilir.');
    }
  }

  /** Same resolution as `VoiceAudioUploadService.resolveCreds`/
   *  `CampaignSenderService.sendVoice` — reuse the workspace's ACTIVE SMS
   *  channel's usercode/password (fax has no separate credential surface).
   *  No ACTIVE SMS channel, or one with incomplete secrets, fails closed
   *  rather than guessing. */
  private async resolveCreds(workspaceId: string): Promise<{ usercode: string; password: string }> {
    const ch = await this.prisma.channel.findFirst({ where: { workspaceId, type: 'SMS', status: 'ACTIVE' } });
    const resolved = ch ? this.registry.resolveConfig(ch) : null;
    const usercode = resolved?.secrets?.usercode;
    const password = resolved?.secrets?.password;
    if (!usercode || !password) {
      throw new ServiceUnavailableException(
        'Faks göndermek için NetGSM hesabı yapılandırılmamış (aktif bir SMS kanalı gerekli).',
      );
    }
    return { usercode, password };
  }
}
