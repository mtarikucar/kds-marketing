import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { FileUp, UserPlus, Blocks, ArrowRight } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, Button,
} from '@/components/ui';

const FIRST_WINS: { key: string; icon: LucideIcon; to: string }[] = [
  { key: 'import', icon: FileUp, to: '/settings/import' },
  { key: 'invite', icon: UserPlus, to: '/users' },
  { key: 'modules', icon: Blocks, to: '/settings/modules' },
];

/**
 * One-time post-register welcome. A plain centered modal (no anchored
 * positioning) that confirms the workspace is ready and points at the 2-3
 * fastest first wins, so a brand-new owner isn't dropped straight onto a wall
 * of empty KPIs. Shown once via the `?welcome=1` deep-link the register flow
 * redirects to; the dashboard strips the param after opening.
 */
export function WelcomeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();

  const go = (to: string) => {
    onClose();
    navigate(to);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('welcome.title', 'Welcome to Jeeta 🎉')}</DialogTitle>
          <DialogDescription>
            {t('welcome.subtitle', 'Your workspace is ready. Here are the fastest ways to get value in the first few minutes.')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {FIRST_WINS.map((w) => {
            const Icon = w.icon;
            return (
              <button
                key={w.key}
                type="button"
                onClick={() => go(w.to)}
                className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-start transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">
                    {t(`welcome.${w.key}.title`, w.key)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t(`welcome.${w.key}.desc`, '')}
                  </span>
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('welcome.later', 'Explore on my own')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
