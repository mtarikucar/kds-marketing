import { request, seg } from './client';
import type {
  DecideInput,
  DncInput,
  DncOut,
  EraseOut,
  KeyKind,
  LiftOut,
  PlaybookOut,
  PoolSettingsInput,
  PoolSettingsOut,
  PromoteInput,
  PromoteOut,
  ProspectCheckInput,
  ProspectCheckOut,
  ProspectGetOut,
  ProspectListOut,
  ProspectListQuery,
  ProspectOut,
  ProspectsReportGroup,
  ProspectsReportOut,
  ScoreOut,
} from './types';

// The prospect pool (`/api/prospects`, spec §7.1): businesses agents research with their own
// tools and record with evidence, apart from the inbox until promoted. Contact values only ever
// travel in bodies (`check`, `do-not-contact`, `do-not-contact/lift` are `POST` for that), never
// in an address.

const root = '/api/prospects';
const one = (id: string) => `${root}/${seg(id)}`;

/** `GET /api/prospects/playbook`: the agents' playbook and the workspace's part of it. */
export const getPlaybook = () => request<PlaybookOut>('GET', `${root}/playbook`);

/** `POST /api/prospects/check`: the refusal `create` would meet, writing nothing. */
export const checkProspect = (input: ProspectCheckInput) =>
  request<ProspectCheckOut>('POST', `${root}/check`, { body: input });

/** `POST /api/prospects`: the body is `jt_prospects::CreateInput` (agents record; people rarely do). */
export const createProspect = (input: Record<string, unknown>) =>
  request<ProspectOut>('POST', root, { body: input });

/** `PATCH /api/prospects/{prospect_id}`: `jt_prospects::UpdateInput`, revision-checked. */
export const updateProspect = (id: string, input: Record<string, unknown>) =>
  request<ProspectOut>('PATCH', one(id), { body: input });

/** `GET /api/prospects`: a page of the pool, newest first. */
export const listProspects = (query: ProspectListQuery) =>
  request<ProspectListOut>('GET', root, { query: { ...query } });

/** `GET /api/prospects/{prospect_id}`: with evidence, scores, duplicates and history. */
export const getProspect = (id: string) => request<ProspectGetOut>('GET', one(id));

/** `POST /api/prospects/{prospect_id}/scores`: `jt_prospects::ScoreInput`. */
export const scoreProspect = (id: string, input: Record<string, unknown>) =>
  request<ScoreOut>('POST', `${one(id)}/scores`, { body: input });

/** `POST /api/prospects/{prospect_id}/decision`: qualify, reject (with a reason) or reopen. */
export const decideProspect = (id: string, input: DecideInput) =>
  request<ProspectOut>('POST', `${one(id)}/decision`, { body: input });

/** `POST /api/prospects/promote`: one outcome per prospect. */
export const promoteProspects = (input: PromoteInput) =>
  request<PromoteOut>('POST', `${root}/promote`, { body: input });

/** `POST /api/prospects/do-not-contact`: destructive, `confirm: true`. */
export const doNotContact = (input: DncInput) =>
  request<DncOut>('POST', `${root}/do-not-contact`, { body: input });

/** `POST /api/prospects/do-not-contact/lift`: a person with `prospects.manage`. */
export const liftDoNotContact = (input: { kind: KeyKind; value: string }) =>
  request<LiftOut>('POST', `${root}/do-not-contact/lift`, { body: input });

/** `POST /api/prospects/{prospect_id}/erase`: destructive, a person with `prospects.manage`. */
export const eraseProspect = (id: string) =>
  request<EraseOut>('POST', `${one(id)}/erase`, { body: { confirm: true } });

/** `GET /api/prospects/settings`. */
export const getPoolSettings = () => request<PoolSettingsOut>('GET', `${root}/settings`);

/** `PUT /api/prospects/settings`: only the keys given change. */
export const setPoolSettings = (input: PoolSettingsInput) =>
  request<PoolSettingsOut>('PUT', `${root}/settings`, { body: input });

/** `GET /api/prospects/report`: `[from, to)` RFC 3339 instants, at most 366 days. */
export const prospectsReport = (query: { from: string; to: string; group_by: ProspectsReportGroup }) =>
  request<ProspectsReportOut>('GET', `${root}/report`, { query: { ...query } });
