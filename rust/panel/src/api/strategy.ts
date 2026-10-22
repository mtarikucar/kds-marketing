import { request, seg } from './client';
import type {
  ArchivedOut,
  ConsultationEntry,
  HypothesisInput,
  RecordKind,
  RecordedOut,
  SectionKey,
  Sections,
  StrategyOut,
  VersionOut,
  VersionSummary,
} from './types';

/** The server's default consultation page, asked for explicitly so "is there more?" is decidable. */
export const CONSULTATION_PAGE_SIZE = 50;

/** `GET /api/strategy`: the approved version, the draft and the draft's gaps. */
export function getStrategy(): Promise<StrategyOut> {
  return request('GET', '/api/strategy');
}

/** `POST /api/strategy/consultation`: opens the next draft, or answers the one already open. */
export function startConsultation(): Promise<VersionOut> {
  return request('POST', '/api/strategy/consultation');
}

/** `POST /api/strategy/consultation/entries` (`201`): one entry in the draft's consultation log. */
export function recordEntry(input: {
  kind: RecordKind;
  section_key?: SectionKey;
  text: string;
}): Promise<RecordedOut> {
  const body: Record<string, unknown> = { kind: input.kind, text: input.text };
  if (input.section_key) body.section_key = input.section_key;
  return request('POST', '/api/strategy/consultation/entries', { body });
}

/** `PUT /api/strategy/draft/sections/{key}`: the body is the section's value as stored. */
export function writeSection<K extends SectionKey>(key: K, value: Sections[K]): Promise<VersionOut> {
  return request('PUT', `/api/strategy/draft/sections/${seg(key)}`, { body: value });
}

/**
 * `PUT /api/strategy/draft/hypotheses`: the whole list as written; each kept one with its `id`,
 * each new one without. One of the approved version left out is retired.
 */
export function setHypotheses(hypotheses: HypothesisInput[]): Promise<VersionOut> {
  return request('PUT', '/api/strategy/draft/hypotheses', { body: hypotheses });
}

/** `POST /api/strategy/draft/submit`: `422 VALIDATION` with `details.gaps` while it has gaps. */
export function submitDraft(): Promise<VersionOut> {
  return request('POST', '/api/strategy/draft/submit');
}

/** `POST /api/strategy/draft/approve`: owner or manager only; answers the version now in force. */
export function approveDraft(): Promise<VersionOut> {
  return request('POST', '/api/strategy/draft/approve');
}

/**
 * `POST /api/strategy/archive`: archives the named approved version; answers `{version_id, archived: true}`,
 * as `jeeta.strategy.archive` does.
 */
export function archiveVersion(input: { version_id: string; confirm: boolean }): Promise<ArchivedOut> {
  return request('POST', '/api/strategy/archive', {
    body: { version_id: input.version_id, confirm: input.confirm },
  });
}

/** `GET /api/strategy/versions`: every version, newest first. */
export function listVersions(): Promise<VersionSummary[]> {
  return request('GET', '/api/strategy/versions');
}

export interface ConsultationQuery {
  limit?: number;
  /** The previous page's last entry: its `at` and its `id`, always together. */
  before_at?: string;
  before_id?: string;
}

/** `GET /api/strategy/versions/{id}/consultation`: one page of the log, newest first. */
export function listConsultation(
  versionId: string,
  query: ConsultationQuery = {},
): Promise<ConsultationEntry[]> {
  return request('GET', `/api/strategy/versions/${seg(versionId)}/consultation`, {
    query: {
      limit: query.limit ?? CONSULTATION_PAGE_SIZE,
      before_at: query.before_at,
      before_id: query.before_id,
    },
  });
}
