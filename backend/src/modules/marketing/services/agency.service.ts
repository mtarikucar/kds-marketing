import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { DEFAULT_BUSINESS_TYPES } from '../dto/create-lead.dto';
import { DEFAULT_ACTIVATED_MODULES } from '../../billing/entitlements.service';

/**
 * Epic D1 — agency / sub-account hierarchy (GoHighLevel parity).
 *
 * An AGENCY workspace owns child LOCATION workspaces. This service is the ONLY
 * sanctioned cross-workspace path in the marketing module: an agency owner may
 * create, list, read and suspend its OWN location sub-accounts. Every
 * cross-into-child action funnels through {@link assertAgencyOwns}, which
 * re-resolves the target by (id, kind=LOCATION, parentWorkspaceId=agency) — so
 * an agency can never touch a location it does not parent, and a STANDALONE /
 * LOCATION workspace can never reach these methods at all (the AGENCY-kind
 * assertion below + the controller's kind gate).
 *
 * This intentionally does NOT loosen MarketingGuard: a normal request is still
 * strictly single-workspace. The agency widening lives here, behind explicit
 * parent-ownership checks, and every mutation is @Audit-logged at the
 * controller with BOTH the agency and location ids.
 *
 * The cross-into-child reads (workspace.findFirst / .findMany / .count keyed on
 * parentWorkspaceId, and the createLocation child-create) are registered as
 * documented exemptions in workspace-scoping.arch.spec.ts — they are legitimate
 * because the parent-ownership invariant, not a workspaceId column on the row,
 * is what bounds them.
 */

const PUBLIC_WORKSPACE_FIELDS = {
  id: true,
  slug: true,
  name: true,
  status: true,
  kind: true,
  parentWorkspaceId: true,
  productName: true,
  productUrl: true,
  defaultLanguage: true,
  defaultCurrency: true,
  timezone: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WorkspaceSelect;

export interface CreateLocationInput {
  name: string;
  productName: string;
  productUrl?: string;
  productDescription?: string;
  language?: string;
  currency?: string;
  timezone?: string;
  /** First OWNER of the new location sub-account. */
  ownerEmail: string;
  ownerPassword: string;
  ownerFirstName: string;
  ownerLastName: string;
}

/** Subdomain-safe slug from a workspace name (mirrors MarketingAuthService). */
function slugify(name: string): string {
  const turkishMap: Record<string, string> = {
    ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u',
  };
  const base = name
    .toLowerCase()
    .replace(/[çğıöşü]/g, (ch) => turkishMap[ch] ?? ch)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'workspace';
}

@Injectable()
export class AgencyService {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  private bcryptCost(): number {
    const raw = this.configService.get<string>('BCRYPT_COST');
    const parsed = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed >= 10 && parsed <= 15 ? parsed : 12;
  }

  /**
   * Re-read the caller's workspace and confirm it is an AGENCY. The controller
   * already gates on kind, but every service entry re-asserts it so a future
   * caller (events, internal API) can't bypass the hierarchy invariant. Returns
   * the agency row so callers don't re-query.
   */
  private async assertIsAgency(agencyWorkspaceId: string) {
    const agency = await this.prisma.workspace.findUnique({
      where: { id: agencyWorkspaceId },
      select: { id: true, kind: true, status: true },
    });
    if (!agency) {
      throw new NotFoundException('Workspace not found');
    }
    if (agency.kind !== 'AGENCY') {
      throw new ForbiddenException('Workspace is not an agency');
    }
    return agency;
  }

  /**
   * THE single cross-into-child guard. Resolves `locationId` ONLY if it is a
   * LOCATION whose `parentWorkspaceId` is exactly `agencyWorkspaceId`. Throws
   * 404 otherwise — so agency-B asking for agency-A's location is
   * indistinguishable from a non-existent id (no cross-tenant enumeration).
   *
   * Every cross-workspace read/mutation in this service goes through here, so
   * the parent-ownership check is the load-bearing isolation boundary that the
   * documented workspace-scoping exemptions point at.
   */
  async assertAgencyOwns(agencyWorkspaceId: string, locationId: string) {
    const location = await this.prisma.workspace.findFirst({
      where: {
        id: locationId,
        kind: 'LOCATION',
        parentWorkspaceId: agencyWorkspaceId,
      },
      select: PUBLIC_WORKSPACE_FIELDS,
    });
    if (!location) {
      throw new NotFoundException('Location not found in this agency');
    }
    return location;
  }

  /**
   * Create a child LOCATION workspace under the calling AGENCY and seed its
   * first OWNER + the per-workspace SYSTEM research sentinel + a DISABLED
   * distribution config — the same minimal bootstrap registerWorkspace lays
   * down, in one transaction. The child carries kind=LOCATION and
   * parentWorkspaceId=<agency>.
   */
  async createLocation(agencyWorkspaceId: string, input: CreateLocationInput) {
    await this.assertIsAgency(agencyWorkspaceId);

    const existing = await this.prisma.marketingUser.findUnique({
      where: { email: input.ownerEmail },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('Owner email is already registered');
    }

    const passwordHash = await bcrypt.hash(input.ownerPassword, this.bcryptCost());

    let location;
    try {
      location = await this.provisionLocation(agencyWorkspaceId, input, passwordHash);
    } catch (e) {
      // The pre-check closes the SEQUENTIAL duplicate; two concurrent
      // createLocation calls with the same owner email both pass it and race on
      // INSERT (the unique index is the real arbiter). Map the loser's P2002 to a
      // clean 409 instead of a raw 500 — mirrors registerWorkspace.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const target = String((e.meta as { target?: unknown } | undefined)?.target ?? '');
        if (target.includes('email')) {
          throw new ConflictException('Owner email is already registered');
        }
        if (target.includes('slug')) {
          throw new ConflictException('Could not allocate a workspace slug');
        }
        throw new ConflictException('That location was just created — refresh the list');
      }
      throw e;
    }
    return location;
  }

  private async provisionLocation(
    agencyWorkspaceId: string,
    input: CreateLocationInput,
    passwordHash: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const base = slugify(input.name);
      let slug = base;
      for (let i = 2; ; i++) {
        const taken = await tx.workspace.findUnique({
          where: { slug },
          select: { id: true },
        });
        if (!taken) break;
        if (i > 50) throw new ConflictException('Could not allocate a workspace slug');
        slug = `${base}-${i}`;
      }

      const child = await tx.workspace.create({
        data: {
          slug,
          name: input.name,
          kind: 'LOCATION',
          parentWorkspaceId: agencyWorkspaceId,
          productName: input.productName,
          productUrl: input.productUrl ?? null,
          productDescription: input.productDescription ?? null,
          defaultLanguage: input.language ?? 'en',
          // TRY default (PayTR-only PSP in prod); agencies can pass a currency.
          defaultCurrency: input.currency ?? 'TRY',
          timezone: input.timezone ?? 'UTC',
          settings: { businessTypes: [...DEFAULT_BUSINESS_TYPES] },
          // Leaner first-run: memberships + research start OFF (see auth register).
          activatedModules: [...DEFAULT_ACTIVATED_MODULES],
        },
        select: PUBLIC_WORKSPACE_FIELDS,
      });

      await tx.marketingUser.create({
        data: {
          workspaceId: child.id,
          email: input.ownerEmail,
          password: passwordHash,
          firstName: input.ownerFirstName,
          lastName: input.ownerLastName,
          role: 'OWNER',
        },
      });

      // Per-workspace research sentinel (unguessable address + random secret;
      // SYSTEM role is refused by login/refresh/guard regardless).
      await tx.marketingUser.create({
        data: {
          workspaceId: child.id,
          email: `research+${child.id}@system.internal`,
          password: await bcrypt.hash(
            `${child.id}:${Date.now()}:${Math.random()}`,
            this.bcryptCost(),
          ),
          firstName: 'AI',
          lastName: 'Research',
          role: 'SYSTEM',
        },
      });

      await tx.marketingDistributionConfig.create({
        data: { workspaceId: child.id, strategy: 'DISABLED' },
      });

      return child;
    });
  }

  /** All LOCATION sub-accounts owned by this agency (scoped to its children). */
  async listLocations(agencyWorkspaceId: string) {
    await this.assertIsAgency(agencyWorkspaceId);

    return this.prisma.workspace.findMany({
      where: { kind: 'LOCATION', parentWorkspaceId: agencyWorkspaceId },
      orderBy: { createdAt: 'desc' },
      select: PUBLIC_WORKSPACE_FIELDS,
    });
  }

  /** One LOCATION the agency owns (404 if not its child). */
  async getLocation(agencyWorkspaceId: string, locationId: string) {
    await this.assertIsAgency(agencyWorkspaceId);
    return this.assertAgencyOwns(agencyWorkspaceId, locationId);
  }

  /**
   * Flip a child LOCATION to SUSPENDED (or back to ACTIVE). Keyed by (id,
   * parentWorkspaceId) so it can only ever touch a row this agency owns; the
   * assertAgencyOwns pre-check turns a foreign/missing id into a 404.
   */
  async suspendLocation(
    agencyWorkspaceId: string,
    locationId: string,
    status: 'SUSPENDED' | 'ACTIVE' = 'SUSPENDED',
  ) {
    await this.assertIsAgency(agencyWorkspaceId);
    await this.assertAgencyOwns(agencyWorkspaceId, locationId);

    if (status !== 'SUSPENDED' && status !== 'ACTIVE') {
      throw new BadRequestException('status must be SUSPENDED or ACTIVE');
    }

    // Mutation is double-keyed on (id, parentWorkspaceId) — even past the
    // pre-check it physically cannot escape this agency's children.
    await this.prisma.workspace.updateMany({
      where: {
        id: locationId,
        kind: 'LOCATION',
        parentWorkspaceId: agencyWorkspaceId,
      },
      data: { status },
    });

    return this.assertAgencyOwns(agencyWorkspaceId, locationId);
  }

  /**
   * Agency dashboard: per-location summary (lead + user counts) plus rollups.
   * Each child count is workspaceId-scoped to that specific location, so this
   * stays inside the agency's own sub-tree.
   */
  async dashboard(agencyWorkspaceId: string) {
    await this.assertIsAgency(agencyWorkspaceId);

    const locations = await this.prisma.workspace.findMany({
      where: { kind: 'LOCATION', parentWorkspaceId: agencyWorkspaceId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        createdAt: true,
      },
    });

    const perLocation = await Promise.all(
      locations.map(async (loc) => {
        const [leadCount, userCount] = await Promise.all([
          // Active leads only — exclude merged-away + soft-deleted rows, so the
          // agency rollup matches what each location's own list/dashboard shows
          // (a consolidated duplicate or a deleted lead must not inflate it).
          this.prisma.lead.count({
            where: { workspaceId: loc.id, mergedIntoId: null, deletedAt: null },
          }),
          this.prisma.marketingUser.count({
            where: { workspaceId: loc.id, role: { not: 'SYSTEM' } },
          }),
        ]);
        return { ...loc, leadCount, userCount };
      }),
    );

    return {
      agencyWorkspaceId,
      locationCount: perLocation.length,
      activeLocationCount: perLocation.filter((l) => l.status === 'ACTIVE').length,
      totalLeads: perLocation.reduce((sum, l) => sum + l.leadCount, 0),
      locations: perLocation,
    };
  }
}
