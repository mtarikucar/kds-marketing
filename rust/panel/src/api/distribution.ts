import { request, seg } from './client';
import type {
  AssignmentsOut,
  AssignmentsQuery,
  Distributed,
  DistributionOut,
  RepOut,
  RepSetInput,
  RulesSetInput,
} from './types';

// Lead distribution (`/api/distribution`, spec §3.9, §7.1): who owns a new journey. Rules apply in
// order, then the implicit default rule in `auto` mode; nothing is ever silently ownerless.

const root = '/api/distribution';

/** `GET /api/distribution`: mode, rules, members' profiles, ownerless and stalled counts. */
export const getDistribution = () => request<DistributionOut>('GET', root);

/** `PUT /api/distribution/rules`: the whole ordered rule set (and the mode). */
export const setRules = (input: RulesSetInput) =>
  request<DistributionOut>('PUT', `${root}/rules`, { body: input });

/** `PUT /api/distribution/reps/{user_id}`: one's own profile, or another's with `inbox.manage`. */
export const setRep = (userId: string, input: RepSetInput) =>
  request<RepOut>('PUT', `${root}/reps/${seg(userId)}`, { body: input });

/** `GET /api/distribution/assignments`: the assignment log, newest first. */
export const listAssignments = (query: AssignmentsQuery = {}) =>
  request<AssignmentsOut>('GET', `${root}/assignments`, { query: { ...query } });

/** `POST /api/distribution/backfill`: distributes up to `limit` (≤ 200) ownerless journeys. */
export const backfill = (input: { limit?: number } = {}) =>
  request<Distributed>('POST', `${root}/backfill`, { body: input });
