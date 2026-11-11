import { ArrowRight, Blocks, Cable, Monitor, Plug } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui';
import { useAbilityCopy } from './abilityCopy';

export function AddAbilityDialog({ open, onOpenChange, onDeclare, onDevices }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeclare: (kind?: string) => void;
  onDevices: () => void;
}) {
  const copy = useAbilityCopy();
  const row = 'flex min-w-0 items-start gap-4 rounded-md px-3 py-4 text-start transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  const content = (Icon: typeof Plug, title: string, body: string) => <>
    <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
    <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{title}</span><span className="mt-1 block text-sm leading-relaxed text-muted-foreground">{body}</span></span>
    <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  </>;
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader><DialogTitle>{copy('add')}</DialogTitle><DialogDescription>{copy('addDescription')}</DialogDescription></DialogHeader>
      <div className="flex flex-col divide-y divide-border">
        <Link to="/connect" className={row} onClick={() => onOpenChange(false)}>{content(Plug, copy('service'), copy('serviceBody'))}</Link>
        <button type="button" className={row} onClick={() => { onOpenChange(false); onDevices(); }}>{content(Monitor, copy('device'), copy('deviceBody'))}</button>
        <button type="button" className={row} onClick={() => { onOpenChange(false); onDeclare('other'); }}>{content(Blocks, copy('custom'), copy('customBody'))}</button>
        <button type="button" className={row} onClick={() => { onOpenChange(false); onDeclare(); }}>{content(Cable, copy('catalog'), copy('catalogBody'))}</button>
      </div>
    </DialogContent>
  </Dialog>;
}
