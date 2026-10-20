import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { isSecretBoxConfigured, openSecret, sealSecret } from '../../../common/crypto/secret-box.helper';
import { WEBHOOK_SECRET_PREFIX } from '../inbound-webhooks/inbound-webhooks.service';

export const COMMERCE_SOURCE_KINDS = ['SHOPIFY', 'WOOCOMMERCE', 'CUSTOM'] as const;
export type CommerceSourceKind = (typeof COMMERCE_SOURCE_KINDS)[number];
export const COMMERCE_SOURCE_SLUG = /^[a-z0-9-]{2,40}$/;
/** How long the replaced secret keeps verifying after a rotation. */
export const PREVIOUS_SECRET_TTL_MS = 24 * 60 * 60 * 1000;

const PUBLIC_FIELDS = {
  id: true,
  slug: true,
  kind: true,
  status: true,
  lastEventAt: true,
  createdAt: true,
} as const;

function newSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('hex')}`;
}

/**
 * The stores allowed to report orders into a workspace (contract §1.7).
 *
 * A signing secret is shown exactly once — in the create or rotate response —
 * and stored SEALED, because verifying an HMAC needs the secret itself. No
 * read path returns it. Revoking keeps the row (its orders still point at it).
 */
@Injectable()
export class CommerceSourcesService {
  constructor(private readonly prisma: PrismaService) {}

  list(workspaceId: string) {
    return this.prisma.commerceSource.findMany({
      where: { workspaceId },
      select: PUBLIC_FIELDS,
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(workspaceId: string, input: { slug: string; kind: CommerceSourceKind }) {
    const slug = String(input.slug ?? '');
    if (!COMMERCE_SOURCE_SLUG.test(slug)) {
      throw new BadRequestException('slug must be 2–40 characters of a-z, 0-9 and "-" (it is the x-jeeta-source header).');
    }
    if (!COMMERCE_SOURCE_KINDS.includes(input.kind)) {
      throw new BadRequestException(`kind must be one of ${COMMERCE_SOURCE_KINDS.join(', ')}.`);
    }
    this.assertSecretBox();
    const signingSecret = newSecret();
    try {
      const row = await this.prisma.commerceSource.create({
        data: { workspaceId, slug, kind: input.kind, signingSecret: sealSecret(signingSecret) },
      });
      return { ...pick(row), signingSecret };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`A commerce source named "${slug}" already exists in this workspace.`);
      }
      throw err;
    }
  }

  /** New secret, shown once; the old one keeps verifying for 24 hours. */
  async rotate(workspaceId: string, id: string, now = new Date()) {
    const row = await this.findActive(workspaceId, id);
    this.assertSecretBox();
    const signingSecret = newSecret();
    const updated = await this.prisma.commerceSource.update({
      where: { id: row.id },
      data: {
        signingSecret: sealSecret(signingSecret),
        previousSecret: row.signingSecret,
        previousSecretExpiresAt: new Date(now.getTime() + PREVIOUS_SECRET_TTL_MS),
      },
    });
    return { ...pick(updated), signingSecret, previousSecretExpiresAt: updated.previousSecretExpiresAt };
  }

  async revoke(workspaceId: string, id: string) {
    const row = await this.findActive(workspaceId, id);
    const updated = await this.prisma.commerceSource.update({
      where: { id: row.id },
      data: { status: 'REVOKED', revokedAt: new Date(), previousSecret: null, previousSecretExpiresAt: null },
    });
    return pick(updated);
  }

  /**
   * The ACTIVE source behind an `x-jeeta-source` header, with the secrets that
   * may verify its signature right now (current first). `null` for an unknown
   * or revoked source — the caller answers 401 UNKNOWN_SOURCE.
   */
  async resolveForVerification(
    workspaceId: string,
    slug: string,
    now = new Date(),
  ): Promise<{ source: { id: string; slug: string }; secrets: string[] } | null> {
    const row = await this.prisma.commerceSource.findFirst({ where: { workspaceId, slug, status: 'ACTIVE' } });
    if (!row) return null;
    const secrets = [openSecret(row.signingSecret)];
    if (row.previousSecret && row.previousSecretExpiresAt && row.previousSecretExpiresAt.getTime() >= now.getTime()) {
      secrets.push(openSecret(row.previousSecret));
    }
    return { source: { id: row.id, slug: row.slug }, secrets };
  }

  private async findActive(workspaceId: string, id: string) {
    const row = await this.prisma.commerceSource.findFirst({ where: { id, workspaceId, status: 'ACTIVE' } });
    if (!row) throw new NotFoundException('Commerce source not found');
    return row;
  }

  private assertSecretBox(): void {
    if (!isSecretBoxConfigured()) {
      throw new ConflictException({
        code: 'SECRET_BOX_NOT_CONFIGURED',
        message: 'MARKETING_SECRET_KEY is not configured on the server, so a signing secret cannot be stored.',
      });
    }
  }
}

function pick(row: { id: string; slug: string; kind: string; status: string; lastEventAt: Date | null; createdAt: Date }) {
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    status: row.status,
    lastEventAt: row.lastEventAt,
    createdAt: row.createdAt,
  };
}
