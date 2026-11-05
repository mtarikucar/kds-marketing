import { request, seg } from './client';
import type {
  ClaimOut,
  TaskCloseInput,
  TaskCreateInput,
  TaskGetOut,
  TaskListOut,
  TaskOut,
  TaskStatus,
} from './types';

// Research tasks (`/api/research/tasks`, spec §3.7, §7.1): the strategy's standing tasks (one per
// ICP entry) and ad-hoc ones a person creates; agents claim them and fill the pool.

const root = '/api/research/tasks';
const one = (id: string) => `${root}/${seg(id)}`;

/** `GET /api/research/tasks`: newest first. */
export const listTasks = (query: { status?: TaskStatus; limit?: number; before_at?: string; before_id?: string } = {}) =>
  request<TaskListOut>('GET', root, { query: { ...query } });

/** `GET /api/research/tasks/{task_id}`: with today's remaining, the count found and the newest. */
export const getTask = (id: string) => request<TaskGetOut>('GET', one(id));

/** `POST /api/research/tasks`: an ad-hoc task. */
export const createTask = (input: TaskCreateInput) => request<TaskOut>('POST', root, { body: input });

/** `POST /api/research/tasks/{task_id}/claim`: an advisory two-hour lease. */
export const claimTask = (id: string) => request<ClaimOut>('POST', `${one(id)}/claim`);

/** `POST /api/research/tasks/{task_id}/close`: done or canceled (ad-hoc tasks only). */
export const closeTask = (id: string, input: TaskCloseInput) =>
  request<TaskOut>('POST', `${one(id)}/close`, { body: input });
