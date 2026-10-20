import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { BrandBrainService } from '../../brand-brain/brand-brain.service';
import { BrandProfileService } from '../../brand-brain/brand-profile.service';
import { KnowledgeService } from '../../ai/knowledge.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface BrandToolDeps {
  brand: BrandBrainService;
  /** Faz 5 D4 — the structured brand profile behind the knowledge chunks. */
  profiles: BrandProfileService;
  /** The knowledge base the Brand Brain chunks — same rows the panel edits. */
  knowledge: Pick<KnowledgeService, 'create' | 'list' | 'remove'>;
}

/** Same cap the panel's CreateKnowledgeDto enforces. */
const MAX_DOC_CHARS = 50_000;

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

  /*
   * Brand knowledge documents — the write side of `search_brand_knowledge`.
   *
   * Until these existed an agent could search the knowledge base but never put
   * anything in it, so a workspace set up over MCP alone searched an empty
   * index forever. Docs go through `KnowledgeService` (the panel's own path:
   * workspace scope and the `maxKnowledgeDocs` package limit under an advisory
   * lock live there) and are then chunked by `BrandBrainService.indexDoc`, so
   * a doc is searchable the moment `add` returns — no separate reindex.
   *
   * All three are deferred: the advertised ceiling is full, and
   * `jeeta.find_tools({ domain: 'brand' })` reaches them.
   */
  registry.register({
    name: 'jeeta.add_brand_knowledge',
    description:
      'Add a brand knowledge document (markdown): a policy, FAQ, product sheet, price list or tone guide the AI should ground its answers in. It is indexed immediately, so jeeta.search_brand_knowledge finds it straight away, and every AI reply the workspace sends may quote it — write only what the business actually told you. Counts against the package knowledge-doc limit.',
    domain: 'brand',
    defer: true,
    // The panel gates POST /ai/knowledge on MANAGER + settings.manage.
    scopes: ['settings.manage'],
    // Workspace configuration: nothing is sent or spent, and the doc can be
    // deleted from the panel. Same reasoning as update_brand_profile.
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      title: z.string().trim().min(1).max(200).describe('Document title, e.g. "Refund policy".'),
      content: z
        .string()
        .min(1)
        .max(MAX_DOC_CHARS)
        .describe(`The document body in markdown, up to ${MAX_DOC_CHARS} characters.`),
      tags: z
        .array(z.string().trim().min(1).max(40))
        .max(20)
        .optional()
        .describe('Optional labels, e.g. ["pricing", "workshop"]. Stored as a "Tags:" line at the end of the document so search finds them.'),
      language: z
        .enum(['tr', 'en', 'ru', 'uz', 'ar'])
        .optional()
        .describe('Language of the document; defaults to tr.'),
    }),
    handler: async (ctx, args) => {
      const title = String(args.title);
      const tags = (args.tags as string[] | undefined) ?? [];
      // No tags column on knowledge_docs; a trailing line keeps them visible in
      // the panel and searchable without a migration.
      const content = tags.length ? `${String(args.content)}\n\nTags: ${tags.join(', ')}` : String(args.content);
      const doc = await deps.knowledge.create(ctx.workspaceId, {
        title,
        content,
        language: (args.language as string | undefined) ?? 'tr',
        source: 'MANUAL',
      });
      try {
        const chunks = await deps.brand.indexDoc(ctx.workspaceId, doc.id, { title, content });
        return { doc, chunks, searchable: true, message: `Added "${doc.title}" (${chunks} chunk(s) indexed).` };
      } catch {
        // The doc exists; failing here would invite a retry that creates a
        // duplicate. Say what happened and how to finish it.
        return {
          doc,
          chunks: 0,
          searchable: false,
          message: `Added "${doc.title}", but indexing failed, so search will not find it yet. Run Reindex on the Brand Brain tab of the panel; do not add it again.`,
        };
      }
    },
  });

  registry.register({
    name: 'jeeta.list_brand_knowledge',
    description:
      "List the workspace's brand knowledge documents (id, title, source, language, status, last update), newest first. Use the id with jeeta.delete_brand_knowledge, and check here before adding so you do not create a duplicate.",
    domain: 'brand',
    defer: true,
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => {
      const docs = await deps.knowledge.list(ctx.workspaceId);
      return { docs, count: docs.length };
    },
  });

  registry.register({
    name: 'jeeta.delete_brand_knowledge',
    description:
      'Permanently delete a brand knowledge document and its search index. Always queued for a human to approve, in every write mode. Get the id from jeeta.list_brand_knowledge.',
    domain: 'brand',
    defer: true,
    scopes: ['settings.manage'],
    // DESTRUCTIVE: the row and its chunks are gone, with no undo — so the
    // broker queues it even under AUTONOMOUS.
    risk: 'DESTRUCTIVE',
    requiresApproval: true,
    approvalKind: 'DESTRUCTIVE',
    resourceType: 'knowledge_doc',
    resourceIdFrom: (args) => (typeof args.docId === 'string' ? args.docId : undefined),
    inputSchema: z.object({
      docId: z.string().min(1).describe('The document id, from jeeta.list_brand_knowledge.'),
    }),
    handler: async (ctx, args) => deps.knowledge.remove(ctx.workspaceId, String(args.docId)),
  });
}
