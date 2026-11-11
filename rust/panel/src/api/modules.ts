import { request, seg } from './client';

/** A portable description of work; it cannot contain executable code or navigation URLs. */
export interface Blueprint {
  id: string;
  name: string;
  description: string;
  version: string;
  requirements: string[];
  workflow: string[];
  builtin: boolean;
}
export interface ModuleConfig {
  brief: string;
  agent_ids: string[];
  capability_ids: string[];
}
export interface WorkspaceModule {
  blueprint: Blueprint;
  installed: boolean;
  required: boolean;
  config: ModuleConfig;
  revision: number;
}
/** Whether a module's capability requirements are met (spec 2026-11-10 module gating). */
export interface ModuleAvailability {
  ready: boolean;
  /** Unmet requirement expressions: kind or group keys joined by `|`. */
  missing: string[];
}
export interface ModulesOut {
  modules: WorkspaceModule[];
  catalog: Blueprint[];
  /** By module id; absent for a module the server did not judge (treated as ready). */
  availability?: Record<string, ModuleAvailability>;
}
export function getModules(): Promise<ModulesOut> {
  return request('GET', '/api/workspace/modules');
}
export function installModule(id: string, blueprint?: Blueprint): Promise<ModulesOut> {
  return request('PUT', `/api/workspace/modules/${seg(id)}`, { body: blueprint ? { blueprint } : {} });
}
export function updateModule(id: string, config: ModuleConfig, revision: number): Promise<ModulesOut> {
  return request('PATCH', `/api/workspace/modules/${seg(id)}`, { body: { config, revision } });
}
export function removeModule(id: string): Promise<ModulesOut> {
  return request('DELETE', `/api/workspace/modules/${seg(id)}`);
}
