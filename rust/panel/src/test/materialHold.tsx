import { useQuery } from '@tanstack/react-query';
import type { RouteObject } from 'react-router-dom';
import { routes } from '@/App';
import { overview } from '@/api/studio';
import { useSession } from '@/auth/useSession';
import { MaterialHold } from '@/pages/materials/MaterialHold';
import { renderAt } from './render';

/** Preserve the material-check component's regression coverage after Today is removed. */
function MaterialHoldHarness() {
  const session = useSession();
  const query = useQuery({ queryKey: ['material-hold-fixture'], queryFn: () => overview({ from: '2026-11-01T00:00:00Z', until: '2026-12-01T00:00:00Z' }), enabled: !!session.data });
  const data = query.data;
  return <>{data?.today.blockers.map((blocker, index) => {
    const target = blocker.target;
    const slot = 'slot' in target ? data.slots.find(row => row.id === target.slot) : undefined;
    return slot ? <MaterialHold key={index} slot={slot} details={blocker.details} shootCount={data.today.shoot_requests?.length ?? 0} /> : null;
  })}</>;
}
const componentRoutes = (rows: RouteObject[]): RouteObject[] => rows.map(row => {
  if (row.path === 'social') return { ...row, element: <MaterialHoldHarness /> };
  return row.children ? { ...row, children: componentRoutes(row.children) } : row;
});
export function renderMaterialHold() {
  return renderAt('/social', { routeConfig: componentRoutes(routes) });
}
