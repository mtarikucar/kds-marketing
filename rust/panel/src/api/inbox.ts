import { request, seg } from './client';
import type {
  InboxConversationRow,
  InboxContext,
  InboxJourney,
  InboxJourneyOut,
  InboxLostReason,
  InboxMerge,
  InboxMessage,
  InboxNote,
  InboxPageOut,
  InboxPendingOut,
  InboxPerson,
  InboxPersonOut,
  InboxQueue,
  InboxReplyOut,
  InboxReportOut,
  InboxTask,
  ReportInput,
} from './types';

const root = '/api/inbox';
const conv = (id: string) => `${root}/conversations/${seg(id)}`;
const journey = (id: string) => `${root}/journeys/${seg(id)}`;
export const listConversations = (queue: InboxQueue, cursor?: string) =>
  request<InboxPageOut<InboxConversationRow>>('GET', `${root}/conversations`, { query: { queue, cursor } });
export const getConversation = (id: string) => request<InboxConversationRow>('GET', conv(id));
export const getContext = (id: string) => request<InboxContext>('GET', `${conv(id)}/context`);
export const listMessages = (id: string, cursor?: string) =>
  request<InboxPageOut<InboxMessage>>('GET', `${conv(id)}/messages`, { query: { cursor } });
export const conversationAction = (
  id: string,
  action: 'take-over' | 'hand-to-agent' | 'unsnooze' | 'close',
) => request<InboxConversationRow>('POST', `${conv(id)}/${action}`);
export const snooze = (id: string, until: string) =>
  request<InboxConversationRow>('POST', `${conv(id)}/snooze`, { body: { until } });
export const reply = (id: string, text: string, request_key?: string, subject?: string) =>
  request<InboxReplyOut>('POST', `${conv(id)}/reply`, { body: { text, intent: 'reply', request_key, ...(subject === undefined ? {} : { subject }) } });
export const searchPeople = (q: string) => request<InboxPerson[]>('GET', `${root}/people`, { query: { q } });
export const getPerson = (id: string) => request<InboxPersonOut>('GET', `${root}/people/${seg(id)}`);
export const getJourney = (id: string) => request<InboxJourneyOut>('GET', journey(id));
export const reportEvent = (id: string, input: ReportInput) =>
  request<InboxReportOut>('POST', `${journey(id)}/events`, { body: input });
export const assignOwner = (id: string, user_id: string | null) =>
  request<InboxJourney>('POST', `${journey(id)}/owner`, { body: { user_id } });
export const listLostReasons = () => request<InboxLostReason[]>('GET', `${root}/lost-reasons`);
export const listMerges = () => request<InboxMerge[]>('GET', `${root}/merges`);
export const applyMerge = (id: string, keep: string) =>
  request<InboxMerge>('POST', `${root}/merges/${seg(id)}/apply`, { body: { keep } });
export const refuseMerge = (id: string) => request<InboxMerge>('POST', `${root}/merges/${seg(id)}/refuse`);
export const undoMerge = (id: string) =>
  request<InboxMerge>('POST', `${root}/merges/${seg(id)}/undo`, { body: { confirm: true } });
export const listTasks = (queue: 'due_24h' | 'overdue' | 'all' = 'all') =>
  request<InboxTask[]>('GET', `${root}/tasks`, { query: { queue } });
export const createTask = (id: string, input: { title: string; due_at: string; assignee: string | null }) =>
  request<InboxTask>('POST', `${journey(id)}/tasks`, { body: input });
export const completeTask = (id: string) => request<InboxTask>('POST', `${root}/tasks/${seg(id)}/complete`);
export const addNote = (id: string, text: string) =>
  request<InboxNote>('POST', `${journey(id)}/notes`, { body: { text } });
export const getInboxPending = () => request<InboxPendingOut>('GET', `${root}/pending`);

export const listCommissions = (state?: import('./types').CommissionState, payee?: string) =>
  request<import('./types').InboxCommission[]>('GET', `${root}/commissions`, { query: { state, payee } });
export const approveCommission = (id: string) =>
  request<import('./types').InboxCommission>('POST', `${root}/commissions/${seg(id)}/approve`);
export const payCommission = (id: string) =>
  request<import('./types').InboxCommission>('POST', `${root}/commissions/${seg(id)}/pay`);
export const setCommissionRate = (input: { user_id: string | null; rate_bp: number }) =>
  request<{ user_id: string | null; rate_bp: number }>('PUT', `${root}/commission-rates`, { body: input });

export const erasePerson = (id: string) => request<{ person_id: string; erased: boolean }>('POST', `${root}/people/${seg(id)}/erase`, { body: { confirm: true } });
