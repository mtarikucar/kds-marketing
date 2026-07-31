import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { BrandBrainService } from '../../brand-brain/brand-brain.service';
import { BrandProfileService } from '../../brand-brain/brand-profile.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface BrandToolDeps {
  brand: BrandBrainService;
  /** Faz 5 D4 — the structured brand profile behind the knowledge chunks. */
  profiles: BrandProfileService;
}

/**
 * Brand knowledge search is a pure read over workspace-scoped chunks, so it
 * needs no approval gate and no user principal — `workspaceId` alone is
 * sufficient tenancy.
 *
 * Faz 5 D4 closes the read/write asymmetry the design spec called out: the
 * brand profile (name, tagline, positioning, tone words, voice guide, ICP,
 * objections, offerings, social handles) was readable only as retrieved
 * knowledge passages and not writable at all, which meant an agent could be
 * TOLD the brand voice but could never record what it learned about it.
 *
 * `jeeta.update_brand_profile` is an unattended `WRITE` and deliberately so:
 * it changes configuration inside the workspace, nothing is sent, published or
 * spent, and every field is reversible from the panel. The blast radius of a
 * wrong tagline is a wrong tagline. The one thing it must not do is silently
 * BLANK fields the caller did not mention — `BrandProfileService.upsert` writes
 * only the keys present in the payload, so the tool forwards only the arguments
 * that were actually supplied (see the clear-doesn't-persist trap: a partial
 * update that spreads `undefined` into every column is how a tone-of-voice edit
 * erases the ICP).
 */
export function registerBrandTools(registry: McpToolRegistry, deps: BrandToolDeps): void {
  registry.register({
    name: 'jeeta.search_brand_knowledge',
    description:
      'Search the workspace brand profile (tone of voice, positioning, products, policies) and return cited passages. Call this before writing any customer-facing copy.',
    domain: 'brand',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe('Free-text search query, e.g. "tone of voice", "refund policy", "target audience".'),
    }),
    handler: async (ctx, args) =>
      deps.brand.search(ctx.workspaceId, { queryText: String(args.query ?? '') }),
  });

  registry.register({
    name: 'jeeta.get_brand_profile',
    description:
      "Read the workspace's structured brand profile: brand name, tagline, description, value propositions, tone words, voice guide, ideal-customer description, common objections, offerings and social handles. Use this (rather than only searching brand knowledge) when you need the whole brand definition at once.",
    domain: 'brand',
    // Deferred (spec §3): `jeeta.search_brand_knowledge` is this domain's
    // advertised representative; the full profile is the occasional deep read.
    defer: true,
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => {
      const profile = await deps.profiles.get(ctx.workspaceId);
      return (
        profile ?? {
          profile: null,
          message:
            'This workspace has no brand profile yet. Create one with jeeta.update_brand_profile, or run the brand analysis in the panel (Brand) to draft it from the website and social accounts.',
        }
      );
    },
  });

  registry.register({
    name: 'jeeta.update_brand_profile',
    description:
      "Update the workspace's brand profile. Only the fields you pass are changed; everything else is left exactly as it was. This is workspace configuration — nothing is published or sent — but it does shape every piece of copy the AI writes afterwards, so keep it faithful to what the customer actually told you.",
    domain: 'brand',
    // Deferred (spec §3): brand definition changes rarely.
    defer: true,
    scopes: ['settings.manage'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      brandName: z.string().min(1).max(200).optional().describe('The brand name.'),
      tagline: z.string().max(300).optional().describe('One-line tagline.'),
      description: z.string().max(4000).optional().describe('What the business does, in prose.'),
      valueProps: z.array(z.string().max(80)).max(30).optional().describe('Short value propositions.'),
      toneWords: z.array(z.string().max(80)).max(30).optional().describe('Words describing the tone of voice.'),
      voiceGuide: z.string().max(4000).optional().describe('How to write as this brand: do/do-not guidance.'),
      icpDescription: z.string().max(4000).optional().describe('The ideal customer.'),
      audienceObjections: z
        .array(z.string().max(300))
        .max(30)
        .optional()
        .describe('Objections this audience commonly raises.'),
      offerings: z
        .array(
          z.object({
            name: z.string().min(1).max(200),
            blurb: z.string().max(1000).optional(),
            price: z.string().max(60).optional(),
          }),
        )
        .max(30)
        .optional()
        .describe('Products or services offered.'),
      socialHandles: z
        .array(z.object({ network: z.string().min(1).max(60), handle: z.string().min(1).max(200) }))
        .max(20)
        .optional()
        .describe('Social accounts, e.g. [{ "network": "instagram", "handle": "@jeeta" }].'),
      status: z.enum(['DRAFT', 'ACTIVE']).optional().describe('ACTIVE makes the profile the live brand definition.'),
    }),
    handler: async (ctx, args) => {
      // Forward ONLY the keys the caller actually supplied. Building a payload
      // with every field present-but-undefined would hand `upsert` a full
      // object and blank the columns nobody asked to change.
      const payload = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
      if (Object.keys(payload).length === 0) {
        // An empty upsert would create a placeholder profile named "My brand"
        // out of nothing and report success. Refuse instead.
        throw new BadRequestException(
          'update_brand_profile needs at least one field to change (e.g. tagline, toneWords, icpDescription).',
        );
      }
      return deps.profiles.upsert(ctx.workspaceId, payload as never);
    },
  });
}
