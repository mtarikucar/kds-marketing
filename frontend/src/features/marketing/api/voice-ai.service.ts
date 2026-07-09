/**
 * voice-ai.service.ts — typed API calls for the Voice-AI feature: post-call
 * analysis, the live-call copilot suggestions, and the capability/status surface.
 * Everything is inert backend-side until the operator sets the NetGSM add-on
 * keys, so these calls degrade gracefully (analysis returns `{status:'NONE'}`,
 * status returns all-false capabilities).
 */

import marketingApi from './marketingApi';

export type CallSentiment = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';

/** A persisted post-call analysis row, surfaced on the call detail. */
export interface CallAnalysis {
  id: string;
  salesCallId: string;
  transcript: string;
  language: string | null;
  summary: string;
  sentiment: CallSentiment | null;
  score: number | null; // 0-100 call-quality/intent score
  actionItems: string[] | null;
  topics: string[] | null;
  sttProvider: string | null;
  createdAt: string;
}

/** No analysis exists yet for the call (recording missing or not yet swept). */
export interface CallAnalysisNone {
  status: 'NONE';
}

export type CallAnalysisResult = CallAnalysis | CallAnalysisNone;

export function isCallAnalysis(r: CallAnalysisResult | undefined): r is CallAnalysis {
  return !!r && (r as CallAnalysisNone).status !== 'NONE';
}

export interface RunAnalysisResult {
  status: 'OK' | 'SKIPPED' | 'FAILED';
  reason?: string;
}

/**
 * GET /marketing/calls/:id/analysis
 * Returns the persisted CallAnalysis or `{ status: 'NONE' }` when none exists.
 */
export const getCallAnalysis = (callId: string): Promise<CallAnalysisResult> =>
  marketingApi.get(`/calls/${callId}/analysis`).then((r) => r.data as CallAnalysisResult);

export interface CallRecordingResult {
  url: string;
}

/**
 * GET /marketing/telephony/calls/:id/recording (NetGSM Phase 4 Task 3)
 * Resolves a playable URL for the call's recording — the R2-stored copy when
 * ingested, else the provider's (possibly short-lived) url. Throws (404) when
 * no recording exists yet; callers should treat that as "no player to show"
 * rather than surface it as an error.
 */
export const getCallRecording = (callId: string): Promise<CallRecordingResult> =>
  marketingApi
    .get(`/telephony/calls/${callId}/recording`)
    .then((r) => r.data as CallRecordingResult);

/**
 * POST /marketing/calls/:id/analysis/run
 * Triggers analysis on demand (recording → STT → Claude). Returns the outcome;
 * caller refetches the analysis afterwards.
 */
export const runCallAnalysis = (callId: string): Promise<RunAnalysisResult> =>
  marketingApi.post(`/calls/${callId}/analysis/run`).then((r) => r.data as RunAnalysisResult);

export interface CopilotSuggestPayload {
  agentProfileId?: string | null;
  transcript: string;
}

export interface CopilotSuggestResult {
  suggestions: string[];
  summary: string;
}

/**
 * POST /marketing/voice-ai/copilot/suggest
 * Given the live transcript so far, returns up to 3 suggested lines the rep can
 * read plus a one-line summary. Knowledge-base grounded server-side.
 */
export const getCopilotSuggestions = (
  payload: CopilotSuggestPayload,
): Promise<CopilotSuggestResult> =>
  marketingApi
    .post('/voice-ai/copilot/suggest', payload)
    .then((r) => r.data as CopilotSuggestResult);

export interface VoiceAiCapabilities {
  stt: boolean;
  bridge: boolean;
  netgsmIvr: boolean;
  copilot: boolean;
}

export interface VoiceAiUrls {
  bridge: string;
  netgsmIvr: string;
  copilotSuggest: string;
}

export interface VoiceAiStatus {
  capabilities: VoiceAiCapabilities;
  urls: VoiceAiUrls;
}

/**
 * GET /marketing/voice-ai/status
 * Capability flags (on/off per feature) + copy-able URL templates. No secrets.
 */
export const getVoiceAiStatus = (): Promise<VoiceAiStatus> =>
  marketingApi.get('/voice-ai/status').then((r) => r.data as VoiceAiStatus);
