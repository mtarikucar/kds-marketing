import { Controller, Get, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { CertificateService } from '../memberships/certificate.service';

/**
 * Public certificate verify page (no auth — gated by the unguessable serial).
 * Renders the printable certificate HTML; the recipient uses the browser's
 * print-to-PDF. Mirrors the public e-sign/invoice pages.
 */
@Controller('public')
export class PublicCertificateController {
  constructor(private readonly certificates: CertificateService) {}

  @Get('certificates/:serial')
  async page(@Param('serial') serial: string, @Res() res: Response): Promise<void> {
    const html = await this.certificates.renderBySerial(serial);
    if (!html) {
      res.status(404).type('html').send('<h1>Certificate not found</h1>');
      return;
    }
    res.type('html').send(html);
  }
}
