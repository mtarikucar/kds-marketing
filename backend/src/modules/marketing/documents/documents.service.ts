import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateDocumentDto, UpdateDocumentDto } from '../dto/document.dto';

/** The consent text frozen onto every document at send time. */
const CONSENT_STATEMENT =
  'By typing my full name and checking this box, I agree that this constitutes ' +
  'my legally binding electronic signature on this document, and that I have ' +
  'reviewed it in full.';

interface SignInput {
  signerName: string;
  signerEmail?: string;
  consent: boolean;
}
interface SignContext {
  ip?: string;
  userAgent?: string;
}

/**
 * E-signature documents / contracts (GoHighLevel parity). Manager CRUD (edits
 * DRAFT-only), send (freezes the body + consent snapshot, mints a public token),
 * void, plus the token-gated public signer flow. The signature binds to the
 * FROZEN `bodySnapshot` — never the live `body` — so a manager can't alter an
 * agreement after it was presented/signed. The audit trail (name/email/ip/UA/
 * timestamp) is written exactly once via a status-conditional claim, so a
 * double-sign race records only the first signer.
 *
 * Workspace-owned: manager reads/writes inline `workspaceId`; public methods are
 * gated by the unguessable `publicToken` (findUnique — exempt; the token IS the
 * capability) and their id-keyed updateMany is whitelisted in the fitness test.
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Manager (workspace-scoped) ─────────────────────────────────────────────

  list(workspaceId: string) {
    return this.prisma.document.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      // Never ship body/snapshot OR the publicToken in the list payload — the
      // token IS the signing capability and SENDING (which mints it) is
      // leads.manage; surfacing it to every leads.read holder would be a
      // privilege inversion. The token is returned only by send() (manager).
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        leadId: true,
        signerName: true,
        signedAt: true,
        sentAt: true,
        createdAt: true,
      },
    });
  }

  /** Internal scoped read — returns the FULL row (callers below need status/
   *  body/publicToken). Not exposed directly; the API uses detail(). */
  async get(workspaceId: string, id: string) {
    const doc = await this.prisma.document.findFirst({ where: { id, workspaceId } });
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  /** API-facing single read — same scoping as get() but strips the signing
   *  capability + frozen evidence from the payload (leads.read must not see the
   *  token). The editable `body` is kept so a manager can edit a draft. */
  async detail(workspaceId: string, id: string) {
    const doc = await this.get(workspaceId, id);
    const { publicToken: _t, bodySnapshot: _s, consentStatement: _c, ...safe } = doc;
    return safe;
  }

  async create(workspaceId: string, dto: CreateDocumentDto) {
    if (dto.leadId) {
      const lead = await this.prisma.lead.findFirst({
        where: { id: dto.leadId, workspaceId },
        select: { id: true },
      });
      if (!lead) throw new NotFoundException('Lead not found');
    }
    return this.prisma.document.create({
      data: {
        workspaceId,
        leadId: dto.leadId ?? null,
        type: dto.type ?? 'AGREEMENT',
        title: dto.title,
        body: dto.body,
      },
    });
  }

  async update(workspaceId: string, id: string, dto: UpdateDocumentDto) {
    const doc = await this.get(workspaceId, id);
    if (doc.status !== 'DRAFT') {
      throw new ConflictException('Only a draft document can be edited');
    }
    const data: Prisma.DocumentUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.body !== undefined) data.body = dto.body;
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.leadId !== undefined) data.leadId = dto.leadId;
    return this.prisma.document.update({ where: { id }, data });
  }

  /** Freeze the body + consent snapshot, mint a public token, go SENT. */
  async send(workspaceId: string, id: string) {
    const doc = await this.get(workspaceId, id);
    if (doc.status === 'SENT') {
      return { status: 'SENT', publicToken: doc.publicToken };
    }
    if (doc.status !== 'DRAFT') {
      throw new ConflictException(`Cannot send a ${doc.status.toLowerCase()} document`);
    }
    const token = `esign_${randomBytes(18).toString('hex')}`;
    const claim = await this.prisma.document.updateMany({
      where: { id, workspaceId, status: 'DRAFT' },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        publicToken: token,
        bodySnapshot: doc.body, // freeze exactly what was presented
        consentStatement: CONSENT_STATEMENT,
      },
    });
    if (claim.count === 0) {
      // Lost a race (concurrent send) — return the now-current token. If the row
      // was hard-deleted in the window, surface a true 404 (not a false SENT).
      const fresh = await this.prisma.document.findFirst({
        where: { id, workspaceId },
        select: { status: true, publicToken: true },
      });
      if (!fresh) throw new NotFoundException('Document not found');
      return { status: fresh.status, publicToken: fresh.publicToken };
    }
    return { status: 'SENT', publicToken: token };
  }

  async void(workspaceId: string, id: string) {
    const doc = await this.get(workspaceId, id);
    if (doc.status === 'SIGNED') {
      throw new ConflictException('A signed document cannot be voided');
    }
    return this.prisma.document.update({
      where: { id },
      data: { status: 'VOIDED', voidedAt: new Date() },
    });
  }

  async remove(workspaceId: string, id: string) {
    const doc = await this.get(workspaceId, id);
    if (doc.status === 'SIGNED') {
      throw new ConflictException('A signed document cannot be deleted (legal record)');
    }
    await this.prisma.document.delete({ where: { id } });
    return { message: 'Document deleted' };
  }

  // ─── Public (signer) flow — gated by the unguessable publicToken ────────────

  async publicView(token: string) {
    const doc = await this.prisma.document.findUnique({
      where: { publicToken: token },
      select: {
        title: true,
        bodySnapshot: true,
        consentStatement: true,
        status: true,
        signerName: true,
        signedAt: true,
      },
    });
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  async publicSign(token: string, input: SignInput, ctx: SignContext) {
    const doc = await this.prisma.document.findUnique({ where: { publicToken: token } });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.status === 'SIGNED') return { status: 'SIGNED' }; // idempotent
    if (doc.status !== 'SENT') {
      throw new ConflictException('This document is no longer available for signing');
    }
    if (!input.consent) throw new BadRequestException('Consent is required to sign');
    const name = input.signerName?.trim();
    if (!name) throw new BadRequestException('Your full name is required to sign');

    // Status-conditional claim: only the FIRST signer flips SENT→SIGNED; a
    // concurrent second call updates 0 rows and records nothing.
    const claim = await this.prisma.document.updateMany({
      where: { id: doc.id, status: 'SENT' },
      data: {
        status: 'SIGNED',
        signerName: name.slice(0, 200),
        signerEmail: input.signerEmail?.trim()?.slice(0, 200) || null,
        signedAt: new Date(),
        signerIp: ctx.ip ?? null,
        signerUserAgent: ctx.userAgent?.slice(0, 1000) ?? null,
      },
    });
    if (claim.count === 0) {
      const fresh = await this.prisma.document.findUnique({
        where: { publicToken: token },
        select: { status: true },
      });
      if (!fresh) throw new NotFoundException('Document not found');
      return { status: fresh.status };
    }
    return { status: 'SIGNED' };
  }

  async publicDecline(token: string) {
    const doc = await this.prisma.document.findUnique({ where: { publicToken: token } });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.status === 'DECLINED') return { status: 'DECLINED' };
    if (doc.status === 'SIGNED') {
      throw new ConflictException('This document was already signed');
    }
    if (doc.status !== 'SENT') {
      throw new ConflictException('This document is no longer available');
    }
    const claim = await this.prisma.document.updateMany({
      where: { id: doc.id, status: 'SENT' },
      data: { status: 'DECLINED', declinedAt: new Date() },
    });
    if (claim.count === 0) {
      const fresh = await this.prisma.document.findUnique({
        where: { publicToken: token },
        select: { status: true },
      });
      if (!fresh) throw new NotFoundException('Document not found');
      return { status: fresh.status };
    }
    return { status: 'DECLINED' };
  }
}
