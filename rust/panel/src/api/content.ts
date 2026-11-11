import { request, seg } from './client';
import type { ProductionProject, ProjectDetail } from './projects';
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
export interface ContentPackage {
  revision: number;
  delivered_at: string;
  by: string;
  summary: string;
  versions: PackageVersion[];
  /** Set when a person accepted what the text check alone held. */
  released?: { by: string; at: string; findings: VersionFindings[] } | null;
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
export const areasList = (scope: 'open' | 'done', done_before?: string) =>
  request<{ projects: ProductionProject[]; next_done_before?: string | null }>('GET', '/api/studio/projects', { query: { scope, done_before } });
/** "Olmamış": `package_revision` is the current package the person was looking at (`null`: none). */
export const areaRedo = (id: string, body: { package_revision: number | null; note: string }) =>
  request<ProjectDetail>('POST', `/api/content/areas/${seg(id)}/redo`, { body });
/** A person accepts the delivery that holds the area, when only its text is held. */
export const deliveryAccept = (id: string, body: { expected_revision: number }) =>
  request<ProjectDetail>('POST', `/api/content/areas/${seg(id)}/delivery/accept`, { body });
