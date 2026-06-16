import type { SegmentGroup, SegmentNode } from '../types';
import { isSegmentGroup } from '../types';

export { isSegmentGroup };

const EMPTY_ROOT: SegmentGroup = { op: 'and', children: [] };

/**
 * Coerce a stored definition into a root GROUP the visual builder can render.
 * The backend accepts either a bare leaf or a group at the top; the builder only
 * models groups, so a bare leaf is wrapped in an implicit AND group. Anything
 * malformed falls back to an empty group (the raw-JSON tab can still edit it).
 */
export function normalizeRoot(def: SegmentNode | null | undefined): SegmentGroup {
  if (!def || typeof def !== 'object') return { ...EMPTY_ROOT, children: [] };
  if (isSegmentGroup(def)) {
    return {
      op: def.op === 'or' ? 'or' : 'and',
      children: Array.isArray(def.children) ? def.children : [],
    };
  }
  // Bare leaf → wrap.
  return { op: 'and', children: [def] };
}
