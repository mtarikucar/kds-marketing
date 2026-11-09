import { request, seg } from './client';
import type { Material, MaterialProduction, MaterialProductionKind } from './materials';
import type { PlannedPost, PostFormat } from './posts';
import type { Slot } from './studio';

export interface ProjectSource {
  material_id: string;
  revision: number;
}
export interface ProjectRequest {
  id: string;
  text: string;
  status: 'open' | 'done' | 'dismissed';
  material_ids: string[];
  created_at: string;
  resolved_at: string | null;
}
export interface ProjectOutput {
  id: string;
  title: string;
  format: PostFormat;
  target_at: string | null;
  capability_id: string | null;
  slot_id: string | null;
}
export interface ProductionProject {
  id: string;
  workspace_id: string;
  title: string;
  brief: string;
  revision: number;
  archived: boolean;
  sources: ProjectSource[];
  requests: ProjectRequest[];
  outputs: ProjectOutput[];
  production_ids: string[];
  invalidated_production_ids: string[];
  created_at: string;
  updated_at: string;
}
export interface ProjectDetail {
  project: ProductionProject;
  materials: Material[];
  productions: MaterialProduction[];
  publications: { output_id: string; slot: Slot; post: PlannedPost | null }[];
}
export type ProjectOutputInput = Omit<ProjectOutput, 'id' | 'slot_id'> & { id?: string };
const root = '/api/studio/projects';
const path = (id: string) => `${root}/${seg(id)}`;
export const projectsList = (archived = false, before?: string) =>
  request<{ projects: ProductionProject[]; next_cursor: string | null }>('GET', root, {
    query: { archived, before },
  });
export const projectGet = (id: string) => request<ProjectDetail>('GET', path(id));
export const projectCreate = (body: {
  request_key: string;
  title: string;
  brief: string;
  material_ids?: string[];
}) => request<ProductionProject>('POST', root, { body });
export const projectUpdate = (
  id: string,
  body: {
    expected_revision: number;
    title?: string;
    brief?: string;
    archived?: boolean;
    outputs?: ProjectOutputInput[];
  },
) => request<ProductionProject>('PATCH', path(id), { body });
export const projectMaterials = (
  id: string,
  body: { expected_revision: number; add: string[]; remove: string[] },
) => request<ProductionProject>('POST', `${path(id)}/materials`, { body });
export const projectRequestCreate = (
  id: string,
  body: { request_key: string; expected_revision: number; text: string },
) => request<ProductionProject>('POST', `${path(id)}/requests`, { body });
export const projectRequestUpdate = (
  id: string,
  requestId: string,
  body: { expected_revision: number; status: ProjectRequest['status']; material_ids?: string[] },
) => request<ProductionProject>('PATCH', `${path(id)}/requests/${seg(requestId)}`, { body });
export const projectProduction = (
  id: string,
  body: {
    request_key: string;
    expected_revision: number;
    kind: MaterialProductionKind;
    instructions: string;
    material_ids: string[];
  },
) =>
  request<{ project: ProductionProject; production: MaterialProduction }>('POST', `${path(id)}/productions`, {
    body,
  });
export const projectPublication = (
  id: string,
  body: { expected_revision: number; output_id: string; slot_id: string },
) => request<ProductionProject>('POST', `${path(id)}/publications`, { body });
export const projectSchedule = (
  id: string,
  outputId: string,
  body: {
    expected_revision: number;
    request_key: string;
    hypothesis_id: string;
    content_type?: string;
    material_ids: string[];
  },
) =>
  request<{ project: ProductionProject; publication: import('./posts').PostOut }>(
    'POST',
    `${path(id)}/outputs/${seg(outputId)}/schedule`,
    { body },
  );
