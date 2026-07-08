import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnthropicService } from '../ai/anthropic.service';
import { AiCreditsService } from '../ai/ai-credits.service';
import { creditCost } from '../ai/ai-credit-costs';
import { SttService } from './stt.service';

export type CallAnalysisStatus = 'OK' | 'SKIPPED' | 'FAILED';
export interface CallAnalysisResult {
  status: CallAnalysisStatus;
  reason?: string;
}

/**
 * Voice-AI Phase 1 — post-call analysis. Loads a SalesCall recording, runs it
 * through STT, then asks Claude for a STRICT-JSON structured analysis
 * (summary/sentiment/score/actionItems/topics) and persists one CallAnalysis
 * row per call. Credit-metered: reserve before the LLM call, refund if Claude
 * (or parse) throws so an errored analysis isn't billed.
 */
@Injectable()
export class CallAnalysisService {
  private readonly logger = new Logger(CallAnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stt: SttService,
    private readonly anthropic: AnthropicService,
    private readonly credits: AiCreditsService,
  ) {}

  async analyzeSalesCall(salesCallId: string): Promise<CallAnalysisResult> {
    const call = await this.prisma.salesCall.findUnique({ where: { id: salesCallId } });
    if (!call || !call.recordingUrl || !call.workspaceId) {
      return { status: 'FAILED', reason: 'no recording' };
    }

    const existing = await this.prisma.callAnalysis.findUnique({ where: { salesCallId } });
    if (existing) return { status: 'SKIPPED', reason: 'already analyzed' };

    const stt = await this.stt.transcribeUrl(call.recordingUrl);
    if (!stt || !stt.text) return { status: 'FAILED', reason: 'no transcript' };

    const cost = creditCost('voice.analysis');
    await this.credits.reserve(call.workspaceId, cost);

    let parsed: ParsedAnalysis;
    try {
      const res = await this.anthropic.complete({
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: stt.text }],
        maxTokens: 600,
        tier: 'default',
      });
      parsed = parseAnalysis(res.text);
    } catch (err) {
      await this.credits.refund(call.workspaceId, cost);
      this.logger.warn(`call analysis failed for ${salesCallId}: ${err?.message || err}`);
      return { status: 'FAILED', reason: 'analysis error' };
    }

    const data = {
      workspaceId: call.workspaceId,
      salesCallId,
      transcript: stt.text,
      language: stt.language ?? null,
      summary: parsed.summary,
      sentiment: parsed.sentiment ?? null,
      score: parsed.score ?? null,
      actionItems: parsed.actionItems ?? null,
      topics: parsed.topics ?? null,
      sttProvider: stt.provider ?? null,
    };
    await this.prisma.callAnalysis.upsert({
      where: { salesCallId },
      create: data,
      update: data,
    });
    return { status: 'OK' };
  }
}

interface ParsedAnalysis {
  summary: string;
  sentiment?: string;
  score?: number;
  actionItems?: string[];
  topics?: string[];
}

const SYSTEM_PROMPT = [
  'You analyze a single sales/support phone-call transcript.',
  'Respond with STRICT JSON only — no prose, no code fences — matching:',
  '{ "summary": string, "sentiment": "POSITIVE"|"NEUTRAL"|"NEGATIVE", "score": number (0-100), "actionItems": string[], "topics": string[] }',
  'summary is 1-3 sentences. score reflects call quality / buying intent.',
  'Reply in the transcript\'s language.',
].join('\n');

/** Tolerant parse: strip ```json fences, JSON.parse, else fall back to {summary:text}. */
function parseAnalysis(text: string): ParsedAnalysis {
  const cleaned = (text || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try {
    const obj = JSON.parse(cleaned);
    if (obj && typeof obj === 'object') {
      return {
        summary: typeof obj.summary === 'string' ? obj.summary : cleaned,
        sentiment: typeof obj.sentiment === 'string' ? obj.sentiment : undefined,
        score: typeof obj.score === 'number' ? obj.score : undefined,
        actionItems: Array.isArray(obj.actionItems) ? obj.actionItems : undefined,
        topics: Array.isArray(obj.topics) ? obj.topics : undefined,
      };
    }
  } catch {
    /* not JSON — fall through to prose summary */
  }
  return { summary: (text || '').trim() };
}
