import { assertJobProvider } from '../ai/ai-job-policy';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { AnthropicService } from '../ai/anthropic.service';
import { AiCreditsService } from '../ai/ai-credits.service';
import { creditCost, tierFor } from '../ai/ai-credit-costs';
import { SttService, SttResult } from './stt.service';
import { R2StorageService } from '../../../common/storage/r2-storage.service';

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
 *
 * NetGSM Phase 4 Task 3 — STT reads the R2-STORED copy of the recording
 * (`recordingStorageKey`, stamped by Task 2's ingest sweep) when one exists,
 * rather than the raw provider `recordingUrl` — a NetGSM tokenized bearer
 * link that can expire well before the cron sweep (or a manual "Analyse"
 * click) gets to it. Falls back to `recordingUrl` only when the recording
 * hasn't been ingested yet (or never will be — recording off / R2
 * unconfigured), matching `SalesCallService.getRecordingUrl`'s preference.
 */
@Injectable()
export class CallAnalysisService {
  private readonly logger = new Logger(CallAnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stt: SttService,
    private readonly anthropic: AnthropicService,
    private readonly credits: AiCreditsService,
    private readonly r2: R2StorageService,
  ) {}

  async analyzeSalesCall(salesCallId: string): Promise<CallAnalysisResult> {
    const call = await this.prisma.salesCall.findUnique({ where: { id: salesCallId } });
    if (!call || !call.workspaceId || (!call.recordingStorageKey && !call.recordingUrl)) {
      return { status: 'FAILED', reason: 'no recording' };
    }

    const existing = await this.prisma.callAnalysis.findUnique({ where: { salesCallId } });
    if (existing) return { status: 'SKIPPED', reason: 'already analyzed' };

    if (!(await this.anthropic.isEnabledFor(call.workspaceId, 'voice.analysis'))) {
      return { status: 'SKIPPED', reason: 'AI is disabled or unavailable for this workspace' };
    }

    const decision = await assertJobProvider(this.prisma, call.workspaceId, 'voice.analysis');
    const recordingRef = call.recordingStorageKey
      ? ['storage', call.recordingStorageKey]
      : ['url', call.recordingUrl];
    const idempotencyScope = `voice.analysis:${call.id}:${createHash('sha256').update(JSON.stringify(recordingRef)).digest('hex')}`;
    // MCP already persists the input before returning AI_MCP_WAITING. Recover
    // only this call's current recording, including the original provenance.
    // An expired inference result can still hold a valid, paid transcript.
    let stt = decision.provider === 'MCP'
      ? await this.persistedTranscript(call.workspaceId, idempotencyScope)
      : null;
    let sttReserved = 0;

    // Transcription costs Jeeta real money (Deepgram/Whisper on a platform
    // key) and used to be charged to nobody: it ran BEFORE any reserve, so a
    // workspace at zero credits still burned it, and a call whose transcript
    // came back empty returned early and was never billed at all. Charge it
    // per minute of audio, up front, and refund if nothing usable comes back.
    if (!stt) {
      const audioUrl = call.recordingStorageKey
        ? this.r2.urlForKey(call.recordingStorageKey)
        : (call.recordingUrl as string);
      const sttCost = creditCost('stt.minute') * Math.max(1, Math.ceil((call.durationSec ?? 60) / 60));
      sttReserved = await this.credits.reserveForJob(call.workspaceId, 'stt.minute', sttCost);
      try {
        stt = await this.stt.transcribeUrl(audioUrl, { workspaceId: call.workspaceId });
      } catch (err) {
        await this.credits.refund(call.workspaceId, sttReserved);
        throw err;
      }
      if (!stt || !stt.text) {
        await this.credits.refund(call.workspaceId, sttReserved);
        return { status: 'FAILED', reason: 'no transcript' };
      }
    }

    let reserved = 0;
    try {
      reserved = await this.credits.reserveForJob(call.workspaceId, 'voice.analysis');
    } catch (err) {
      // The STT charge was already taken — possibly out of PREPAID credits.
      // Refusing the analysis here without handing it back bills the customer
      // for a transcript that gets discarded.
      await this.credits.refund(call.workspaceId, sttReserved).catch(() => undefined);
      throw err;
    }

    let parsed: ParsedAnalysis;
    try {
      const res = await this.anthropic.complete({
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: decision.provider === 'MCP'
          ? JSON.stringify({ transcription: { text: stt.text, provider: stt.provider, language: stt.language ?? null } })
          : stt.text }],
        maxTokens: 600,
        tier: tierFor('voice.analysis'),
        workspaceId: call.workspaceId,
        action: 'voice.analysis',
        idempotencyScope,
      });
      parsed = parseAnalysis(res.text);
    } catch (err) {
      await this.credits.refund(call.workspaceId, reserved);
      const response = err instanceof HttpException ? err.getResponse() : null;
      if (response && typeof response === 'object' && (response as { code?: string }).code === 'AI_MCP_WAITING') {
        return { status: 'SKIPPED', reason: 'AI_MCP_WAITING: Bağlı Claude yanıtı bekleniyor.' };
      }
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

  private async persistedTranscript(workspaceId: string, idempotencyScope: string): Promise<SttResult | null> {
    const task = await this.prisma.scheduledJob.findFirst({
      where: {
        workspaceId,
        kind: 'ai.mcp.inference',
        AND: [
          { payload: { path: ['action'], equals: 'voice.analysis' } },
          { payload: { path: ['idempotencyScope'], equals: idempotencyScope } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: { payload: true },
    });
    const payload = task?.payload as { input?: { messages?: { role?: string; content?: unknown }[] } } | undefined;
    const messages = payload?.input?.messages;
    if (!Array.isArray(messages) || messages.length !== 1 || messages[0]?.role !== 'user' || typeof messages[0].content !== 'string') return null;
    try {
      const transcription = JSON.parse(messages[0].content)?.transcription;
      if (!transcription || typeof transcription.text !== 'string' || !transcription.text.trim() ||
        typeof transcription.provider !== 'string' ||
        (transcription.language != null && typeof transcription.language !== 'string')) return null;
      return { text: transcription.text, provider: transcription.provider, language: transcription.language ?? undefined };
    } catch {
      return null;
    }
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
