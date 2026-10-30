import { request, seg } from './client';

// Phone calls (`/api/calls`, voice V0): the call log, one call with its turns, placing a rep's
// call, recording how it went, and the call policy. Numbers arrive masked (`counterpart`); only
// a person holding `calls.manage` gets `counterpart_e164` in one call's view.

/** `jt_calls::CallState`. */
export type CallState = 'planned' | 'dialing' | 'ringing' | 'live' | 'holding' | 'ending' | 'ended';
/** `jt_calls::CallPurpose`. */
export type CallPurpose = 'service' | 'commercial' | 'callback';
export const CALL_PURPOSES: readonly CallPurpose[] = ['service', 'commercial', 'callback'];
/** `jt_calls::CallOutcome`. */
export type CallOutcome =
  | 'connected'
  | 'no_answer'
  | 'voicemail'
  | 'refused_by_customer'
  | 'appointment'
  | 'callback_requested'
  | 'other';
export const CALL_OUTCOMES: readonly CallOutcome[] = [
  'connected',
  'no_answer',
  'voicemail',
  'refused_by_customer',
  'appointment',
  'callback_requested',
  'other',
];
/** `jt_calls::RefusalReason` keys, as `details.reason` of a refused `POST /api/calls`. */
export const REFUSAL_REASONS = [
  'workspace_inactive',
  'strategy_required',
  'bridge_offline',
  'bridge_busy',
  'person_erased',
  'person_merged',
  'no_phone_identity',
  'suppressed',
  'journey_lost',
  'consent_missing',
  'no_relationship',
  'no_recent_inbound',
  'outside_work_hours',
  'daily_ops_cap',
  'budget_exhausted',
  'disclosure_missing',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/** A call as the server shows it (`jt_app::usecases::calls::CallOut.call`). */
export interface CallView {
  id: string;
  capability_id: string;
  direction: 'inbound' | 'outbound';
  purpose: CallPurpose;
  person_id: string | null;
  journey_id: string | null;
  mode: { kind: 'agent' } | { kind: 'human'; rep_extension: string };
  state: CallState;
  /** Masked, e.g. `+90 5** *** ** 67`. */
  counterpart: string;
  /** Only for a person holding `calls.manage`, in one call's view. */
  counterpart_e164?: string;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  end_cause: { cause: string; detail?: string } | null;
  outcome: CallOutcome | null;
  summary: string | null;
  duration_s: number | null;
  cost_minor: number | null;
  recording: { state: 'off' | 'pending' | 'recording'; file_ref?: string | null };
}

/** `jt_calls::TurnKind`. */
export type TurnKind =
  | { kind: 'utterance' }
  | { kind: 'say'; by: 'agent' | 'script' }
  | { kind: 'holding' }
  | { kind: 'fallback' }
  | { kind: 'dtmf' }
  | { kind: 'event'; name: string };

/** `jt_calls::Turn`. */
export interface CallTurn {
  seq: number;
  at: string;
  kind: TurnKind;
  text: string;
  meta: { confidence?: number; latency_ms?: number; interrupted_at_char?: number; stt_ms?: number };
}

export interface CallOut {
  call: CallView;
  turns: CallTurn[];
}

/** `jt_calls::CallPolicy`. */
export interface CallPolicy {
  greeting_inbound: string;
  voicemail_text: string;
  recording_announcement: string;
  disclose_assistant: boolean;
  disclosure_sentence: string;
  holding_default: string[];
  max_duration_s: number;
  slow_agent_s: number;
  holding_again_s: number;
  fallback_after_s: number;
  caller_silence_s: number;
  caller_silence_close_s: number;
  handoff_extension: string | null;
  estimated_minor_per_minute: number;
}

export interface PlaceInput {
  person_id?: string;
  phone?: string;
  purpose: CallPurpose;
  mode: 'human';
  rep_extension: string;
}

export interface EndInput {
  outcome: CallOutcome;
  summary?: string;
}

/** `GET /api/calls`: newest first. */
export function listCalls(query: { person_id?: string; state?: CallState; limit?: number } = {}): Promise<CallView[]> {
  return request('GET', '/api/calls', { query: { ...query } });
}

/** `GET /api/calls/{call_id}`. */
export function getCall(id: string): Promise<CallOut> {
  return request('GET', `/api/calls/${seg(id)}`);
}

/** `POST /api/calls`: a refusal is `409` with `details.reason` (a {@link RefusalReason}). */
export function placeCall(input: PlaceInput): Promise<CallOut> {
  const body: Record<string, unknown> = {
    purpose: input.purpose,
    mode: input.mode,
    rep_extension: input.rep_extension,
  };
  if (input.person_id) body.person_id = input.person_id;
  if (input.phone) body.phone = input.phone;
  return request('POST', '/api/calls', { body });
}

/** `POST /api/calls/{call_id}/end`. */
export function endCall(id: string, input: EndInput): Promise<CallOut> {
  const body: Record<string, unknown> = { outcome: input.outcome };
  if (input.summary?.trim()) body.summary = input.summary.trim();
  return request('POST', `/api/calls/${seg(id)}/end`, { body });
}

/** `GET /api/calls/policy`. */
export function getCallPolicy(): Promise<CallPolicy> {
  return request('GET', '/api/calls/policy');
}

/** `PUT /api/calls/policy`: the whole policy. */
export function setCallPolicy(policy: CallPolicy): Promise<CallPolicy> {
  return request('PUT', '/api/calls/policy', { body: policy });
}
