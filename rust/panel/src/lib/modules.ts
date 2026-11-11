import { useQuery } from '@tanstack/react-query';
import type { Permission } from '@/api/types';
import { getModules, type Blueprint, type ModulesOut, type WorkspaceModule } from '@/api/modules';
import { useSession } from '@/auth/useSession';

export const modulesKey = (workspaceId: string | null | undefined) => ['workspace-modules', workspaceId] as const;
export function useModules() {
  const workspaceId = useSession().data?.current_workspace;
  return useQuery({ queryKey: modulesKey(workspaceId), queryFn: getModules, enabled: !!workspaceId });
}
const BUILTIN_PATHS: Record<string, string> = {
  inbox: '/inbox', strategy: '/strategy', content: '/content', social: '/social', ads: '/ads', materials: '/materials', people: '/people',
  prospects: '/prospects', outreach: '/outreach', calls: '/calls',
};
export function modulePath(module: WorkspaceModule | Blueprint): string {
  const blueprint = 'blueprint' in module ? module.blueprint : module;
  return blueprint.builtin && BUILTIN_PATHS[blueprint.id]
    ? BUILTIN_PATHS[blueprint.id]
    : `/modules/${encodeURIComponent(blueprint.id)}`;
}
export function moduleSettingsPath(id: string): string { return `/modules/${encodeURIComponent(id)}`; }
/** The module's unmet capability requirements; empty when it is ready or was not judged. */
export function moduleMissing(data: ModulesOut | undefined, id: string): string[] {
  return data?.availability?.[id]?.missing ?? [];
}
export function moduleReady(data: ModulesOut | undefined, id: string): boolean {
  return moduleMissing(data, id).length === 0;
}
export function lines(value: string): string[] { return value.split('\n').map(line => line.trim()).filter(Boolean); }
/** Export only portable definitions. Workspace IDs, credentials and agent assignments never travel. */
export function portableBlueprint(blueprint: Blueprint): Omit<Blueprint, 'builtin'> {
  const { id, name, description, version, requirements, workflow } = blueprint;
  return { id, name, description, version, requirements, workflow };
}
export function parseBlueprint(value: unknown): Blueprint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const allowed = new Set(['id', 'name', 'description', 'version', 'requirements', 'workflow']);
  if (Object.keys(v).some(key => !allowed.has(key))) return null;
  if (typeof v.id !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(v.id)) return null;
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 120) return null;
  if (typeof v.description !== 'string' || v.description.length > 2000) return null;
  if (typeof v.version !== 'string' || !v.version.trim() || v.version.length > 32) return null;
  for (const key of ['requirements', 'workflow']) {
    const a = v[key];
    if (!Array.isArray(a) || a.length > 50 || a.some(x => typeof x !== 'string' || !x.trim() || x.length > 500)) return null;
  }
  return { id: v.id, name: v.name.trim(), description: v.description, version: v.version,
    requirements: v.requirements as string[], workflow: v.workflow as string[], builtin: false };
}

/** Domain permissions remain in force when an optional module is installed. */
export function moduleVisibleTo(module: WorkspaceModule | Blueprint, me: import('@/api/types').MeOut | undefined): boolean {
  const blueprint = 'blueprint' in module ? module.blueprint : module;
  const membership = me?.memberships.find(m => m.workspace_id === me.current_workspace);
  if (!blueprint.builtin) return true;
  const permissions: Record<string, Permission> = {
    prospects: 'prospects.work', outreach: 'outreach.work',
    content: 'content.work', social: 'social.work', ads: 'ads.work', materials: 'materials.work',
  };
  const permission = permissions[blueprint.id];
  return !permission || !!membership?.permissions.includes(permission);
}
