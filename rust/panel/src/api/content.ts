import { request, seg } from './client';
import type { Actor, Material, MaterialIntelligence, Olay, OccasionKind } from './materials';
import type { ProjectDetail } from './projects';
import type { PostFormat } from './posts';

export type AreaState = 'queued' | 'working' | 'waiting_material' | 'done' | 'held' | 'archived';
export interface PackageVersion {
  id: string;
  format: PostFormat;
  capability_id: string | null;
  text: string;
  title: string | null;
  tags: string[];
  link: string | null;
  material_ids: string[];
  hypothesis_id: string;
  content_type: string | null;
  slot_id: string | null;
}
/** One step the agent reported in an area's current attempt (design 2026-11-18 O9). */
export interface AreaStep {
  step: number;
  note: string;
  at: string;
  /** One line of what the step produced. */
  output?: string;
  material_ids?: string[];
}
export interface ContentPackage {
  revision: number;
  delivered_at: string;
  by: string;
  summary: string;
  versions: PackageVersion[];
  /** Set when a person accepted what the text check alone held. */
  released?: { by: string; at: string; findings: VersionFindings[] } | null;
  /** The steps that made it (an accepted delivery copies them). */
  steps?: AreaStep[];
}
/** One thing that holds a version: `material` findings are never accepted, `text` ones may be. */
export interface DeliveryFinding {
  kind?: 'material' | 'text';
  code: string;
  material_id?: string | null;
  olay_id?: string | null;
  matched?: string;
  message?: string;
}
export interface VersionFindings { index: number; findings: DeliveryFinding[] }
export interface RefusedDelivery {
  at: string;
  by: string;
  summary: string;
  versions: PackageVersion[];
  findings: VersionFindings[];
}

// The content page's read model (`jt_app::usecases::content::{views, pipeline}`, design
// 2026-11-18): the tree, the analysis queue, the production line and one olay's view.

export type WaitReason = 'olay_proposed' | 'shoot_request' | 'material_request' | 'content_approval' | 'content_time' | 'content_problem';
export interface Folder {
  files: number;
  areas: number;
  published: number;
  waits: WaitReason[];
}
/** `ahead`: its preparation day has not come; `preparing`: it has, the window has not started; `open`: the window runs now. */
export type DayPhase = 'ahead' | 'preparing' | 'open';
/**
 * A special day of the calendar with no olay yet. The system opens no olay for it: from
 * `prepares_from` it makes content for the confirmed olay of the day once that olay has a usable
 * file, and while there is none it asks for a capture on the çekim listesi (`shoot_request_id`).
 */
export interface UpcomingDay {
  key: string;
  year: number;
  name: string;
  kind: OccasionKind;
  window_start: string;
  window_end: string;
  prepares_from: string;
  phase: DayPhase;
  shoot_request_id: string | null;
}
export interface TreeOut {
  /** Every olay, newest start first. */
  olays: (Folder & { olay: Olay })[];
  genel: Folder;
  /** Special days coming up within 120 days with no olay yet. */
  upcoming: UpcomingDay[];
  analysis_queue: number;
  /** Every area not archived ("Tüm üretim"). */
  areas: number;
  /** `content_times`: finished contents waiting for an account and a time some account can take. */
  waiting: { olay_confirmations: number; shoot_requests: number; content_approvals: number; content_times: number; problem_contents: number };
}
export type QueueStage = 'waiting' | 'analysing' | 'needs_filing' | 'failed';
export interface QueueItem {
  material: Material;
  intelligence: MaterialIntelligence;
  unfiled: boolean;
  stage: QueueStage;
}
export type StageKey = 'hazirlik' | 'fikir' | 'metin' | 'gorsel' | 'paket' | 'onay' | 'yayin' | 'sonuc';
export type StageState = 'done' | 'current' | 'waiting_person' | 'problem' | 'todo';
export interface PackageSummary {
  revision: number;
  delivered_at: string;
  summary: string;
  released: boolean;
  versions: { id: string; format: PostFormat; capability_id: string | null; title: string | null; material_ids: string[]; slot_id: string | null }[];
}
export interface ApprovalFact {
  version_id: string;
  slot_id: string;
  required: boolean;
  waiting: boolean;
  approved_by: string | null;
  approved_at: string | null;
}
export interface PublicationFact {
  version_id: string;
  slot_id: string;
  capability_id: string;
  account_name: string | null;
  state: 'planned' | 'ready' | 'published' | 'measured' | 'retired';
  scheduled_at: string;
  published_at: string | null;
  url: string | null;
  failed: boolean;
  /** Why it was retired unsent, when it was (`cancelled`, `missed_grace`, `replanned`, ...). */
  retirement?: string;
}
export interface ResultFact {
  version_id: string;
  publication_id: string;
  window: 'hours24' | 'hours72' | 'days7';
  measured_at: string;
  metrics: Record<string, number | null>;
}
/** A stage's lists are absent when empty (the server skips them). */
export interface Stage {
  key: StageKey;
  state: StageState;
  span: [number, number] | null;
  steps?: AreaStep[];
  package?: PackageSummary;
  approvals?: ApprovalFact[];
  publications?: PublicationFact[];
  results?: ResultFact[];
}
/** Why no account can take a waiting version, as `social.versions_waiting` says it. */
export const BLOCKED_REASONS = [
  'no_approved_strategy',
  'no_connected_account',
  'account_paused',
  'its_account_unavailable',
  'format_not_supported',
  'channel_not_in_strategy',
  'hypothesis_does_not_post',
] as const;
/** A version of the finished package with no planned post yet: it waits for an account and a time. */
export interface TimeWait {
  version_id: string;
  format: PostFormat;
  capability_id: string | null;
  /** The accounts it could go out on now. */
  accounts: string[];
  /** Why none can take it now; absent while some account can. */
  blocked?: string;
}
export interface Pipeline {
  current_step: number | null;
  /** Always eight, in order. */
  stages: Stage[];
  /** The versions of the finished package that wait for a time (empty when none). */
  unscheduled: TimeWait[];
}
export type OpenedBy = { kind: 'human' } | { kind: 'system'; trigger: 'olay' | 'calendar' | 'floor'; key: string };
export interface AreaSummary {
  id: string;
  title: string;
  brief: string;
  olay_id: string | null;
  opened_by: OpenedBy;
  hints: { formats: PostFormat[]; capability_ids: string[] };
  status: { state: AreaState; step: number | null; note: string | null; starts_at: string };
  revision: number;
  /** `withdrawn`: the planned posts the redo took back. */
  redo: { note: string; by: string; at: string; withdrawn?: string[] } | null;
  open_requests: number;
  created_at: string;
  updated_at: string;
}
export interface AreaRow {
  area: AreaSummary;
  pipeline: Pipeline;
}
export interface AreasOut {
  areas: AreaRow[];
  next_cursor: string | null;
  next_done_before: string | null;
}
export interface Flow {
  files: number;
  analysed: number;
  in_queue: number;
  contents: number;
  in_production: number;
  /** Finished contents waiting for an account and a time. */
  awaiting_time: number;
  awaiting_approval: number;
  published: number;
  problems: number;
}
export interface FileRow {
  material: Material;
  intelligence: MaterialIntelligence;
  /** The areas that use it. */
  used_in: string[];
}
export interface Need {
  kind: 'shoot_request' | 'material_request';
  id: string;
  text: string;
  status: 'open' | 'done' | 'dismissed';
  created_at: string;
  resolved_at: string | null;
  project_id: string | null;
  project_title: string | null;
  material_ids: string[];
  asked_by: Actor | null;
}
export interface OlayViewOut {
  /** `null` for Genel. */
  olay: Olay | null;
  flow: Flow;
  /** `null` without a content permission. */
  contents: AreaRow[] | null;
  /** `null` without `materials.work`. */
  files: FileRow[] | null;
  needs: Need[];
}
/** The folder of everything of no olay, as the routes name it. */
export const GENEL = 'genel';

export const contentTree = () => request<TreeOut>('GET', '/api/content/tree');
export const analysisQueue = () => request<{ items: QueueItem[] }>('GET', '/api/content/analysis-queue');
/** A page of the production line; `olay_id` is an olay's id or `genel`. */
export const contentAreas = (q: { scope?: 'open' | 'done'; done_before?: string; before?: string; archived?: boolean; olay_id?: string }) =>
  request<AreasOut>('GET', '/api/content/areas', { query: { ...q } });
/** One olay, or `genel`. */
export const olayView = (id: string) => request<OlayViewOut>('GET', `/api/content/olays/${seg(id)}`);
/** "Düzenleme iste": `package_revision` is the current package the person was looking at (`null`: none). */
export const areaRedo = (id: string, body: { package_revision: number | null; note: string }) =>
  request<ProjectDetail>('POST', `/api/content/areas/${seg(id)}/redo`, { body });
/** A person accepts the delivery that holds the area, when only its text is held. */
export const deliveryAccept = (id: string, body: { expected_revision: number }) =>
  request<ProjectDetail>('POST', `/api/content/areas/${seg(id)}/delivery/accept`, { body });
