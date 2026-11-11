import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui';

export type WorkspaceScene = 'strategy' | 'studio' | 'connections' | 'research';

/**
 * A workspace page's title. Every page shares one header: the full-width title bar under the
 * shell's header (owner decision 2026-11-10, "no margins, every page the same"), so the former
 * editorial photograph of `scene` is no longer drawn; the prop stays for the call sites.
 */
export function WorkspaceHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  scene?: WorkspaceScene;
}) {
  return <PageHeader title={title} description={description} actions={actions} />;
}
