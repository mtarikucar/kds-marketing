import { useNavigate, type RouteObject } from 'react-router-dom';
import { routes } from '@/App';
import { ModuleGate } from '@/layout/ModuleGate';
import { StudioProjects } from '@/pages/projects/StudioProjects';
import { renderAt } from './render';

function LegacyProjects() {
  const navigate = useNavigate();
  return <ModuleGate moduleId="content"><StudioProjects onOpenSlot={id => navigate(`/social?slot=${encodeURIComponent(id)}`)} /></ModuleGate>;
}

/** Retain component regression coverage after /content replaces the legacy project editor.
 * The production route and its new behavior are covered by pages/content tests. */
const componentRoutes = (rows: RouteObject[]): RouteObject[] => rows.map(row => {
  if (row.path === 'content') return { ...row, element: <LegacyProjects /> };
  if (row.children) return { ...row, children: componentRoutes(row.children) };
  return row;
});
export function renderLegacyProjects(path: string) {
  return renderAt(path, { routeConfig: componentRoutes(routes) });
}
