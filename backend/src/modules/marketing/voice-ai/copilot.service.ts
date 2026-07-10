import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnthropicService } from '../ai/anthropic.service';
import { AiCreditsService } from '../ai/ai-credits.service';
import { creditCost } from '../ai/ai-credit-costs';
import { KnowledgeService } from '../ai/knowledge.service';

export interface CopilotSuggestion {
  suggestions: string[];
  summary: string;
}

/**
 * Voice-AI Phase 4 — live agent copilot (REST). The browser captures the live
 * call transcript (its own speech recognition) and POSTs the running transcript;
 * this service asks Claude for short next-things-to-say plus a one-line summary
 * to help a HUMAN sales rep. Grounded on the channel's AgentProfile + knowledge
 * base. Credit-metered: reserve before the LLM call, refund if Claude throws.
 *
 * Inert when Anthropic is disabled — returns an empty suggestion set rather than
 * throwing, so the panel stays harmless until AI is configured.
 */
@Injectable()
export class CopilotService {
  private readonly logger = new Logger(CopilotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly anthropic: AnthropicService,
    private readonly credits: AiCreditsService,
    private readonly knowledge: KnowledgeService,
  ) {}

  async suggest(
    workspaceId: string,
    agentProfileId: string | null,
    transcriptSoFar: string,
  ): Promise<CopilotSuggestion> {
    if (!this.anthropic.isEnabled()) return { suggestions: [], summary: '' };

    const agent = agentProfileId
      ? await this.prisma.agentProfile.findFirst({ where: { id: agentProfileId, workspaceId } })
      : null;

    const kbDocIds = agent && Array.isArray(agent.kbDocIds) ? (agent.kbDocIds as string[]) : undefined;
    const kb = await this.knowledge.search(workspaceId, lastCustomerLine(transcriptSoFar), kbDocIds, 3);

    const lang = agent?.language ?? 'tr';
    const parts = [
      'You assist a HUMAN sales rep on a LIVE call. Given the running transcript, return STRICT JSON',
      '{"suggestions":[up to 3 short next-things-to-say], "summary":"one line"}.',
      `Language: ${lang}.`,
      agent?.persona ? `Persona: ${agent.persona}` : '',
      agent?.guardrails ? `Guardrails (never violate): ${agent.guardrails}` : '',
    ];
    if (kb.length) {
      parts.push('KB facts you may use:');
      for (const d of kb) parts.push(`- ${d.title}: ${d.snippet}`);
    }

    const cost = creditCost('voice.copilot');
    await this.credits.reserve(workspaceId, cost);

    let res: { text: string };
    try {
      res = await this.anthropic.complete({
        system: parts.filter(Boolean).join('\n'),
        messages: [{ role: 'user', content: transcriptSoFar }],
        maxTokens: 200,
        tier: 'conversation',
      });
    } catch (err) {
      await this.credits.refund(workspaceId, cost);
      throw err;
    }

    return parseSuggestion(res.text);
  }
}

/** The text of the last "Customer:"-labelled line, else the whole transcript. */
function lastCustomerLine(transcript: string): string {
  const lines = (transcript || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^(?:customer|müşteri|caller)\s*:\s*(.+)$/i);
    if (m) return m[1].trim();
  }
  return (transcript || '').trim();
}

/** Tolerant parse: strip ```json fences, JSON.parse, else fall back to {suggestions:[text]}. */
function parseSuggestion(text: string): CopilotSuggestion {
  const cleaned = (text || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj === 'object') {
      return {
        suggestions: Array.isArray(obj.suggestions)
          ? obj.suggestions.filter((s: unknown) => typeof s === 'string')
          : [],
        summary: typeof obj.summary === 'string' ? obj.summary : '',
      };
    }
  } catch {
    /* not JSON — fall through to prose suggestion */
  }
  const fallback = (text || '').trim();
  return { suggestions: fallback ? [fallback] : [], summary: '' };
}
