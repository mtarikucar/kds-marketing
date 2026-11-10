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
export interface ModulesOut {
  modules: WorkspaceModule[];
  catalog: Blueprint[];
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
