import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as api from '@/api/studio';
import type { LaneKind } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { canAny } from '@/lib/roles';
import { StudioLearned } from './StudioLearned';
import { StudioReadStatus, useOverviewWindow, useStudioKey } from './StudioShared';

export function StrategyLearned() {
  const session = useSession();
  const key = useStudioKey();
  const allowed = canAny(session.data, ['content.work', 'social.work', 'ads.work']);
  const [lane, setLane] = useState<LaneKind>();
  const query: api.Query = { ...useOverviewWindow(), lane };
  const overview = useQuery({ queryKey: [...key, 'overview', query], queryFn: () => api.overview(query), enabled: allowed, refetchInterval: 60_000 });
  if (!allowed) return null;
  return <div className="space-y-4"><StudioReadStatus query={overview} /><StudioLearned data={overview.data} query={query} lane={lane} onLane={setLane} /></div>;
}
