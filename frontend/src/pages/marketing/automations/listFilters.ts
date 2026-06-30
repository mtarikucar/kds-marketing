import type { WorkflowRow } from './automationTypes';

/** Narrow the workflow list by a free-text search (name or trigger type) and a
 *  status chip ('ALL' = no status filter). Pure. */
export function filterWorkflows(rows: WorkflowRow[], f: { search: string; status: string }): WorkflowRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.status !== 'ALL' && r.status !== f.status) return false;
    if (!q) return true;
    return r.name.toLowerCase().includes(q) || (r.trigger?.type ?? '').toLowerCase().includes(q);
  });
}
