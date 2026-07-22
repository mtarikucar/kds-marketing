import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LucideIcon } from 'lucide-react';
import { Command, PanelLeft, Plus, Blocks } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
  Progress,
} from '@/components/ui';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { useTourStore } from '../../../store/tourStore';

const STEPS: { key: string; icon: LucideIcon }[] = [
  { key: 'palette', icon: Command },
  { key: 'focus', icon: PanelLeft },
  { key: 'create', icon: Plus },
  { key: 'modules', icon: Blocks },
];

/**
 * A short, centered product tour that teaches the console's key affordances
 * (command palette, focused nav, quick create, module catalog). Deliberately a
 * centered stepper — not element-anchored popovers — so it's robust regardless
 * of layout/viewport. It does NOT auto-start — on first signup the WelcomeDialog
 * is the single first-touch surface — and is launched only on demand from the
 * "Take a tour" menu entry (which calls the store's setOpen(true)). Finishing or
 * skipping latches `dismissed` per workspace, which the menu relaunch ignores.
 */
export default function ProductTour() {
  const { t } = useTranslation('marketing');
  const user = useMarketingAuthStore((s) => s.user);
  const ws = user?.workspaceId ?? 'unknown';

  const open = useTourStore((s) => s.open);
  const dismiss = useTourStore((s) => s.dismiss);

  const [step, setStep] = useState(0);

  const finish = () => {
    dismiss(ws);
    setStep(0);
  };

  if (!open) return null;

  const current = STEPS[step];
  const Icon = current.icon;
  const isLast = step === STEPS.length - 1;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) finish(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <span className="mb-1 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Icon className="h-5 w-5" />
          </span>
          <DialogTitle>{t(`tour.steps.${current.key}.title`, current.key)}</DialogTitle>
          <DialogDescription>{t(`tour.steps.${current.key}.body`, '')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <p className="text-xs text-muted-foreground">
            {t('tour.progress', {
              step: step + 1,
              total: STEPS.length,
              defaultValue: '{{step}} of {{total}}',
            })}
          </p>
          <Progress value={((step + 1) / STEPS.length) * 100} tone="primary" />
        </div>

        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" size="sm" onClick={finish}>
            {t('tour.skip', 'Skip')}
          </Button>
          <div className="flex gap-2">
            {step > 0 && (
              <Button variant="outline" size="sm" onClick={() => setStep((n) => n - 1)}>
                {t('tour.back', 'Back')}
              </Button>
            )}
            {isLast ? (
              <Button size="sm" onClick={finish}>
                {t('tour.done', 'Got it')}
              </Button>
            ) : (
              <Button size="sm" onClick={() => setStep((n) => n + 1)}>
                {t('tour.next', 'Next')}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
