import { Link } from 'react-router-dom';
import { Callout } from '@/components/ui';
import { useModuleCopy } from './copy';
export function ActivationNotice() {
  const copy = useModuleCopy();
  return <Callout tone="info"><p className="text-sm leading-6">{copy('workspaceInactive')}</p><Link to="/billing" className="mt-2 inline-block text-sm underline underline-offset-4">{copy('reviewActivation')}</Link></Callout>;
}
