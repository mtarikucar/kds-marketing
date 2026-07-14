import Anthropic from '@anthropic-ai/sdk';
import { ResearchSourcesService } from './providers/research-sources.service';
import { ResearchSpendService } from '../budget/research-spend.service';
import { AgentRunService } from '../agents/agent-run.service';

/**
 * The research agent's tools. Source tools (places/scrape/web/instagram) map to
 * the platform-keyed providers; `submit_candidates` is the terminal tool the
 * model calls to finalize its qualified list (handled by the worker, not here).
 */
export const RESEARCH_TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_places',
    description: 'Search Google Maps for businesses matching a query within the profile geo. Returns name, contact, category, rating and recent reviews (the primary source of pain signals).',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer', description: '1-30' } },
      required: ['query'],
    },
  },
  {
    name: 'scrape_page',
    description: 'Fetch one web page (a business site, directory listing or review page) as markdown to read for evidence.',
    input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'search_web',
    description: 'Web search for directories, news, social profiles or reviews relevant to the ICP.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query'],
    },
  },
  {
    name: 'lookup_instagram',
    description: 'Look up a single Instagram business handle (bio, followers, external link) to confirm a reachable social channel.',
    input_schema: { type: 'object', properties: { handle: { type: 'string' } }, required: ['handle'] },
  },
  {
    name: 'submit_candidates',
    description: 'Finalize the qualified lead candidates. Call this exactly once when done. Each candidate MUST include externalRef, businessName, businessType, painPoint, evidence, pitch (in the profile language).',
    input_schema: {
      type: 'object',
      properties: {
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              externalRef: { type: 'string' }, businessName: { type: 'string' }, city: { type: 'string' }, region: { type: 'string' },
              businessType: { type: 'string' }, phone: { type: 'string' }, instagram: { type: 'string' }, website: { type: 'string' }, email: { type: 'string' },
              branchCount: { type: 'integer' }, currentSystem: { type: 'string' },
              stage: { type: 'string', enum: ['GROWING', 'STRUGGLING', 'STABLE'] },
              priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
              painPoint: { type: 'string' }, evidence: { type: 'string' }, pitch: { type: 'string' }, score: { type: 'number' },
            },
            required: ['externalRef', 'businessName', 'businessType', 'painPoint', 'evidence', 'pitch'],
          },
        },
      },
      required: ['candidates'],
    },
  },
];

export interface ResearchToolDeps {
  sources: ResearchSourcesService;
  spend: ResearchSpendService;
  runs: AgentRunService;
}

export interface ResearchToolCtx {
  workspaceId: string;
  runId: string;
  geo: { country?: string | null; regions?: string[] | null; cities?: string[] | null };
  budgetId?: string | null;
}

/**
 * Executes one source tool: calls the provider, meters the cost into the RESEARCH
 * budget ONLY when the provider call actually succeeded, and records a
 * ToolCallLog. Never throws — a tool failure is returned as a string so the
 * model can adapt (matching the AskAiService loop contract). Two failure legs
 * deliberately skip the meter: a not-configured provider (pre-checked here —
 * its inert []/null would otherwise be billed as a run) and a failed call (the
 * configured providers THROW on HTTP/network failure, landing in the catch).
 */
export async function dispatchResearchTool(
  deps: ResearchToolDeps,
  ctx: ResearchToolCtx,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const meter = (unit: 'FIRECRAWL_PAGE' | 'APIFY_RUN', qty = 1) =>
    deps.spend.settle(ctx.workspaceId, { unit, quantity: qty, ref: ctx.runId, budgetId: ctx.budgetId ?? null });
  const notConfigured = (provider: string) => ({
    error: `${provider} is not configured on this platform — use the other research tools instead`,
  });

  let result: unknown;
  let ok = true;
  let error: string | undefined;
  try {
    switch (name) {
      case 'search_places': {
        if (!deps.sources.apify.isConfigured()) {
          ok = false;
          result = notConfigured('apify');
          error = (result as { error: string }).error;
          break;
        }
        const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 30);
        result = await deps.sources.apify.searchPlaces({ query: String(args.query ?? ''), geo: ctx.geo, limit });
        await meter('APIFY_RUN');
        break;
      }
      case 'scrape_page': {
        if (!deps.sources.firecrawl.isConfigured()) {
          ok = false;
          result = notConfigured('firecrawl');
          error = (result as { error: string }).error;
          break;
        }
        result = await deps.sources.firecrawl.scrape(String(args.url ?? ''));
        await meter('FIRECRAWL_PAGE');
        break;
      }
      case 'search_web': {
        if (!deps.sources.firecrawl.isConfigured()) {
          ok = false;
          result = notConfigured('firecrawl');
          error = (result as { error: string }).error;
          break;
        }
        const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20);
        result = await deps.sources.firecrawl.searchWeb(String(args.query ?? ''), limit);
        await meter('FIRECRAWL_PAGE');
        break;
      }
      case 'lookup_instagram': {
        if (!deps.sources.apify.isConfigured()) {
          ok = false;
          result = notConfigured('apify');
          error = (result as { error: string }).error;
          break;
        }
        result = await deps.sources.apify.lookupInstagram(String(args.handle ?? ''));
        await meter('APIFY_RUN');
        break;
      }
      default:
        ok = false;
        error = `unknown tool: ${name}`;
        result = { error };
    }
  } catch (e) {
    ok = false;
    error = e instanceof Error ? e.message : 'tool error';
    result = { error };
  }
  await deps.runs.recordTool(ctx.workspaceId, ctx.runId, { tool: name, args, result, ok, error }).catch(() => undefined);
  return result;
}
