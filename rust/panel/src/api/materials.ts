import { request, seg } from './client';

// The materials library of Growth Studio ("Materyaller", spec 2026-11-03 §4, §5.2): olays,
// materials and their tags, the calendar, the materials policy and the çekim listesi. Shapes are
// the serde forms of `jt_studio` (olay, material, calendar, shoot, eligibility, selection) and of
// `jt_app::usecases::studio::library`. Calendar days are `YYYY-MM-DD`; instants RFC 3339.

/** `jt_studio::OlayKind`, every variant. */
export const OLAY_KINDS = ['workshop', 'order', 'season', 'special_day', 'product_shoot', 'other'] as const;
export type OlayKind = (typeof OLAY_KINDS)[number];
/** Whether an olay of `kind` lives in a calendar occasion's windows (it names its `occasion`). */
export const isSeasonal = (kind: OlayKind) => kind === 'season' || kind === 'special_day';
export type OlayStatus = 'proposed' | 'confirmed';
/** A human's decision and when it was taken. */
export interface HumanMark {
  by: string;
  at: string;
}
export interface OlayClient {
  person_id?: string | null;
  organization?: string | null;
}
export interface Olay {
  id: string;
  workspace_id: string;
  kind: OlayKind;
  title: string;
  starts_on: string;
  ends_on: string;
  place: string | null;
  client: OlayClient | null;
  notes: string;
  occasion: string | null;
  status: OlayStatus;
  confirmed: HumanMark | null;
  revision: number;
  created_at: string;
}
export interface OlayListItem {
  olay: Olay;
  /** Its live materials. */
  materials: number;
}
export interface OlayDetail {
  olay: Olay;
  materials: MaterialDetail[];
  /** Its open çekim listesi requests. */
  shoot_requests: ShootRequest[];
}
export interface OlayInput {
  kind: OlayKind;
  title: string;
  starts_on: string;
  ends_on: string;
  place?: string | null;
  client?: OlayClient | null;
  notes?: string;
  occasion?: string | null;
}

/** The closed tag vocabularies (`jt_studio::material`), in the server's order. */
export const PRODUCT_GROUPS = [
  'figur',
  'diorama_tablo',
  'anlamli_yer_maket',
  'sezon_urunu',
  'atolye',
  'pazaryeri',
] as const;
export const DOORS = ['kisiye_ozel', 'toplu_siparis', 'ortaklik'] as const;
export const CONTENT_TYPES = [
  'bitmis_urun',
  'once_sonra',
  'uretim_baski',
  'boyama',
  'paketleme',
  'teslim_tepki',
  'atolye_ani',
] as const;
export const QUALITIES = ['publishable', 'needs_crop', 'unusable'] as const;
export const DEPICTS = ['face', 'name', 'child', 'client_logo', 'corporate_ref'] as const;
export type ProductGroup = (typeof PRODUCT_GROUPS)[number];
export type Door = (typeof DOORS)[number];
export type ContentType = (typeof CONTENT_TYPES)[number];
export type Quality = (typeof QUALITIES)[number];
export type Depicts = (typeof DEPICTS)[number];
export interface Tags {
  /** Workspace-specific labels; absent on records from older servers. */
  labels?: string[];
  product_groups: ProductGroup[];
  doors: Door[];
  content_types: ContentType[];
  quality: Quality | null;
  depicts: Depicts[];
}
export const SHARE_PERMISSIONS = ['shareable', 'not_shareable', 'product_only'] as const;
export type SharePermission = (typeof SHARE_PERMISSIONS)[number];
/** A share permission and who gave it: a person, or (`by: null`) the agent that added an AI image. */
export interface ShareDecision {
  permission: SharePermission;
  by: string | null;
  at: string;
}
export type Origin = { kind: 'real' } | { kind: 'ai_generated'; generator: string };
export type Binding = { kind: 'olay'; olay_id: string } | { kind: 'genel' };
/** `jt_ledger::Actor`. */
export type Actor =
  | { kind: 'human'; user_id: string }
  | { kind: 'agent'; connection_id: string; user_id: string }
  | { kind: 'system'; component: string };
export interface Material {
  id: string;
  workspace_id: string;
  file_id: string;
  mime: string;
  title: string;
  origin: Origin;
  binding: Binding;
  /** A person marked it "genel kullanılabilir". */
  freed: HumanMark | null;
  share: ShareDecision | null;
  tags: Tags;
  /** The person who confirmed or corrected the tags last; `null`: they are an agent's suggestion. */
  tags_reviewed_by: string | null;
  /** The inbox persons it shows. */
  people: string[];
  captured_at: string | null;
  created_by: Actor;
  revision: number;
  created_at: string;
  erased_at: string | null;
}
export type UseRole = 'anchor' | 'support';
export interface PublishedIn {
  publication_id: string;
  capability_id: string;
  external_id: string;
  url: string | null;
  published_at: string;
}
/** A piece revision that showed a material, its slot and what it was published as. */
export interface UsedIn {
  slot_id: string;
  piece_id: string;
  revision: number;
  role: UseRole;
  slot_state: 'planned' | 'ready' | 'published' | 'measured' | 'retired' | null;
  scheduled_at: string | null;
  publications: PublishedIn[];
}
export interface MaterialDetail {
  material: Material;
  used_in: UsedIn[];
}
export interface MaterialAddInput {
  request_key: string;
  file_id: string;
  olay_id?: string;
  genel?: boolean;
  origin: Origin;
  title?: string;
  labels?: string[];
  product_groups?: ProductGroup[];
  doors?: Door[];
  content_types?: ContentType[];
  quality?: Quality | null;
  depicts?: Depicts[];
  people?: string[];
  share?: SharePermission;
  captured_at?: string;
}
export interface MaterialAddOut {
  material: Material;
  /** The olays whose dates contain the capture day, nearest first; nothing is bound by them. */
  olay_suggestions: Olay[];
}
/** Each field given replaces that set (`[]` empties it; `quality: null` clears it). */
export interface MaterialTagInput {
  title?: string;
  captured_at?: string | null;
  labels?: string[];
  product_groups?: ProductGroup[];
  doors?: Door[];
  content_types?: ContentType[];
  quality?: Quality | null;
  depicts?: Depicts[];
  people?: string[];
}
export type MaterialState = 'live' | 'erased' | 'needs_review' | 'all';

export type MaterialProductionKind = 'edit' | 'crop' | 'poster';
export interface MaterialProduction {
  id: string;
  workspace_id: string;
  kind: MaterialProductionKind;
  instructions: string;
  sources: { material_id: string; expected_revision: number }[];
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  output_material_id: string | null;
  last_error_code: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface MaterialIntelligence {
  status: 'pending' | 'running' | 'completed' | 'failed';
  description: string;
  group_name: string | null;
  date_source: 'unknown' | 'exif' | 'file_modified' | 'agent_inferred' | 'manual';
  attempts: number;
  analyzed_revision: number | null;
  last_error_code: string | null;
  analyzed_at: string | null;
  updated_at: string;
  manual_fields: string[];
}
export interface MaterialIntelligenceOut {
  material: Material;
  intelligence: MaterialIntelligence | null;
}
export interface MaterialMetadataInput {
  description?: string;
  group_name?: string | null;
}

/** What a piece speaks about (spec D7). */
export type Subject =
  | { kind: 'olay'; olay_id: string }
  | { kind: 'archive'; olay_id: string }
  | { kind: 'generic' };
export interface SlotCandidate {
  material_id: string;
  file_id: string;
  mime: string;
  subject: Subject;
  role: UseRole;
  matches_need: boolean;
}
export interface SlotMaterials {
  slot_id: string;
  scheduled_at: string;
  need: { product_groups?: ProductGroup[]; doors?: Door[]; content_types?: ContentType[] };
  /** Best first: a material appears once for every subject it may take. */
  candidates: SlotCandidate[];
  refused: { material_id: string; code: string }[];
}

export type OccasionKind = 'season' | 'special_day';
export interface CalendarEntry {
  key: string;
  year: number;
  name: string;
  kind: OccasionKind;
  /** Both `null`: no dates yet (inactive until the owner enters them). */
  window_start: string | null;
  window_end: string | null;
  /** `null`: the materials policy's `lead_days`. */
  lead_days: number | null;
  enabled: boolean;
}
export interface MaterialPolicy {
  lead_days: number;
  reuse_days: number;
  recap_days: number;
}
export interface CalendarOut {
  year: number;
  entries: CalendarEntry[];
  /** What the workspace changed or entered for the year. */
  rows: CalendarEntry[];
  policy: MaterialPolicy;
}

export type ShootReason =
  | { kind: 'slot_unfilled'; hypothesis_id: string; content_type: string }
  | { kind: 'season_ahead'; occasion: string; year: number }
  | { kind: 'season_dates_missing'; occasion: string; year: number }
  | { kind: 'olay_upcoming'; olay_id: string }
  | { kind: 'requested' };
export type ShootStatus = 'open' | 'done' | 'dismissed';
export interface ShootRequest {
  id: string;
  workspace_id: string;
  key: string;
  reason: ShootReason;
  /** What to shoot or upload, in Turkish. */
  text: string;
  /** The Istanbul Monday of its week. */
  week_start: string;
  status: ShootStatus;
  created_by: Actor;
  created_at: string;
  resolved_by: Actor | null;
  resolved_at: string | null;
}

const root = '/api/studio';
const olay = (id: string) => `${root}/olays/${seg(id)}`;
const material = (id: string) => `${root}/materials/${seg(id)}`;

export const olaysList = (status?: OlayStatus) =>
  request<OlayListItem[]>('GET', `${root}/olays`, { query: { status } });
export const olayGet = (id: string) => request<OlayDetail>('GET', olay(id));
/** A person who is an owner or manager creates it confirmed; anyone else proposes it. */
export const olayCreate = (body: OlayInput & { request_key: string }) =>
  request<Olay>('POST', `${root}/olays`, { body });
/** The fields given change; `null` clears an optional one. */
export const olayUpdate = (id: string, expected_revision: number, body: Partial<OlayInput>) =>
  request<Olay>('PATCH', olay(id), { body: { ...body, expected_revision } });
/** An owner or manager confirms a proposed olay (panel only). */
export const olayConfirm = (id: string, expected_revision: number) =>
  request<Olay>('POST', `${olay(id)}/confirm`, { body: { expected_revision } });

export const materialsList = (q: { olay_id?: string; state?: MaterialState } = {}) =>
  request<Material[]>('GET', `${root}/materials`, { query: { ...q } });
export const materialGet = (id: string) => request<MaterialDetail>('GET', material(id));
export const materialProductions = (source_material_id: string) =>
  request<MaterialProduction[]>('GET', `${root}/material-productions`, { query: { source_material_id } });
export const materialProductionRequest = (body: {
  request_key: string;
  kind: MaterialProductionKind;
  instructions: string;
  sources: { material_id: string; expected_revision: number }[];
}) => request<MaterialProduction>('POST', `${root}/material-productions`, { body });
export const materialIntelligenceList = () =>
  request<MaterialIntelligenceOut[]>('GET', `${root}/material-intelligence`);
export const materialIntelligence = (id: string) =>
  request<MaterialIntelligenceOut>('GET', `${material(id)}/intelligence`);
export const materialAnalysisRetry = (id: string, expected_revision: number) =>
  request<MaterialIntelligenceOut>('POST', `${material(id)}/analysis/retry`, { body: { expected_revision } });
export const materialMetadata = (id: string, expected_revision: number, body: MaterialMetadataInput) =>
  request<MaterialIntelligenceOut>('PATCH', `${material(id)}/intelligence`, {
    body: { ...body, expected_revision },
  });
export const materialPreview = (id: string) =>
  request<{ url: string; expires_at: string }>('GET', `${material(id)}/preview`);

/** Adds a file stored by `studio.file_upload` (`fileUpload`) as a material. */
export const materialAdd = (body: MaterialAddInput) =>
  request<MaterialAddOut>('POST', `${root}/materials`, { body });
export const materialTag = (id: string, expected_revision: number, body: MaterialTagInput) =>
  request<Material>('PATCH', `${material(id)}/tags`, { body: { ...body, expected_revision } });
/** Owner or manager (panel only); revoking is `not_shareable`. */
export const materialPermission = (id: string, expected_revision: number, permission: SharePermission) =>
  request<Material>('PUT', `${material(id)}/permission`, {
    body: { expected_revision, permission },
  });
/** Owner or manager (panel only): "genel kullanılabilir" on a real material, or taken back. */
export const materialFree = (id: string, expected_revision: number, free: boolean) =>
  request<Material>('POST', `${material(id)}/free`, { body: { expected_revision, free } });
/** Owner or manager (panel only): another olay, or genel. */
export const materialBind = (id: string, expected_revision: number, binding: Binding) =>
  request<Material>('POST', `${material(id)}/bind`, { body: { expected_revision, binding } });
/** Owner or manager (panel only): the bytes go, the record stays for what it was used in. */
export const materialDelete = (id: string, expected_revision: number) =>
  request<Material>('POST', `${material(id)}/delete`, {
    body: { expected_revision, confirm: true },
  });
/** What the slot's piece may show at the slot's time. */
export const slotMaterials = (slotId: string) =>
  request<SlotMaterials>('GET', `${root}/slots/${seg(slotId)}/materials`);

export const calendarList = (year?: number) =>
  request<CalendarOut>('GET', `${root}/calendar`, { query: { year } });
/** Owner or manager (panel only): the row of `key` and `year`, replacing the one there. */
export const calendarSet = (entry: CalendarEntry) => {
  const { key, year, ...body } = entry;
  return request<CalendarEntry>('PUT', `${root}/calendar/${seg(key)}/${year}`, { body });
};
/** Owner or manager (panel only). */
export const materialPolicySet = (policy: MaterialPolicy) =>
  request<MaterialPolicy>('PUT', `${root}/materials/policy`, { body: policy });

/** A caption finding of the truth check (spec §7): what a piece's text names that its olays do not back. */
export interface CaptionFinding {
  code: string;
  olay_id?: string | null;
  material_id?: string | null;
  /** What matched, folded (the token, the date as written, or the missing year). */
  matched: string;
}
/** `studio.slot_get`'s `material_check`: the truth check of the piece revision a slot shows. */
export interface MaterialCheck {
  revision: number;
  findings: CaptionFinding[];
  /** What a release names: any new or changed finding changes it. */
  digest: string;
  released: boolean;
  /** Eligibility refusals, never releasable. */
  hard: { code: string; material_id?: string | null }[];
  holds: boolean;
}
/** One finding of a `material_check_hold` blocker (`details`). */
export interface HoldFinding {
  kind?: 'hard' | 'caption';
  code: string;
  material_id?: string | null;
  olay_id?: string | null;
  matched?: string;
}
/**
 * An owner or manager, in person, releases the caption findings of a slot's piece at its revision
 * (panel only); a hard finding is never releasable.
 */
export const materialCheckRelease = (slotId: string, expected_revision: number, digest: string) =>
  request('POST', `${root}/slots/${seg(slotId)}/material-check/release`, {
    body: { expected_revision, digest },
  });

export const shootList = (status?: ShootStatus | 'all') =>
  request<ShootRequest[]>('GET', `${root}/shoot-requests`, { query: { status } });
export const shootRequest = (body: { request_key: string; text: string; week_start?: string }) =>
  request<ShootRequest>('POST', `${root}/shoot-requests`, { body });
export const shootResolve = (id: string, status: 'done' | 'dismissed') =>
  request<ShootRequest>('POST', `${root}/shoot-requests/${seg(id)}/resolve`, { body: { status } });

/** The Istanbul calendar day of `at` (`YYYY-MM-DD`; Istanbul is UTC+03 all year). */
export function istanbulDay(at: Date): string {
  return new Date(at.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
}
/** The Monday of `day`'s week (`YYYY-MM-DD` in, `YYYY-MM-DD` out). */
export function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86400_000).toISOString().slice(0, 10);
}
/**
 * The olays a material taken on Istanbul day `day` may belong to, as the server answers them
 * (`jt_studio::olay_suggestions`): those whose dates contain it, the one starting nearest to it
 * first, then the shorter, then by id.
 */
export function olaySuggestions(olays: Olay[], day: string): Olay[] {
  const days = (a: string, b: string) =>
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000;
  return olays
    .filter((o) => o.starts_on <= day && day <= o.ends_on)
    .sort(
      (a, b) =>
        days(a.starts_on, day) - days(b.starts_on, day) ||
        days(a.starts_on, a.ends_on) - days(b.starts_on, b.ends_on) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}
