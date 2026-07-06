import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Check, Rocket, Sparkles, Wallet } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Switch } from '@/components/ui/Switch';
import { Badge } from '@/components/ui/Badge';
import { Callout } from '@/components/ui/Callout';
import { Stepper } from '@/components/ui/Stepper';
import { navigateExternal } from '@/lib/navigateExternal';
import {
  getWalletState,
  quickStart,
  walletTopup,
  type CheckoutHandle,
  type QuickStartManifest,
} from '../../../features/marketing/api/growthBudget.service';
import { money, num, pickTopupProvider } from './autopilotMath';

const CHANNEL_LABEL: Record<string, string> = {
  META: 'Meta', TIKTOK: 'TikTok', GOOGLE: 'Google', LINKEDIN: 'LinkedIn',
  CONTENT: 'Content', SMS: 'SMS', VOICE: 'Voice', WHATSAPP: 'WhatsApp',
};

export interface EnableAutopilotWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful quick-start so the parent can refresh queries. */
  onProvisioned?: (manifest: QuickStartManifest) => void;
}

/**
 * "Enable Autopilot" — the product's one-click promise (spec D12/G). ONE
 * dialog: (1) see/load growth credit, (2) confirm the monthly cap + goal
 * (prefilled from the wallet), (3) flip the arm switch — a SINGLE quick-start
 * call provisions everything (wallet, budget, channel allocations, autonomy)
 * and the success screen shows the returned manifest so the user sees exactly
 * what was set up for them.
 */
export function EnableAutopilotWizard({ open, onOpenChange, onProvisioned }: EnableAutopilotWizardProps) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [topupAmount, setTopupAmount] = useState('');
  const [cap, setCap] = useState('');
  const [capTouched, setCapTouched] = useState(false);
  const [targetRoas, setTargetRoas] = useState('');
  const [arm, setArm] = useState(true);
  const [iframeUrl, setIframeUrl] = useState<string | null>(null);
  const [bankRef, setBankRef] = useState<string | null>(null);
  const [manifest, setManifest] = useState<QuickStartManifest | null>(null);

  const walletQ = useQuery({ queryKey: ['growth-wallet'], queryFn: getWalletState, enabled: open });
  const wallet = walletQ.data;
  const balance = num(wallet?.balance);
  const currency = wallet?.currency ?? 'TRY';

  // Reset the flow each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setTopupAmount('');
    setCap('');
    setCapTouched(false);
    setTargetRoas('');
    setArm(true);
    setIframeUrl(null);
    setBankRef(null);
    setManifest(null);
  }, [open]);

  // Prefill the cap from the loaded wallet balance until the user edits it.
  useEffect(() => {
    if (!capTouched && balance > 0) setCap(String(balance));
  }, [balance, capTouched]);

  const topup = useMutation({
    mutationFn: () => walletTopup({ amount: Number(topupAmount), provider: pickTopupProvider(currency) }),
    onSuccess: ({ handle }) => followHandle(handle),
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? t('autopilot.wizard.topupError', 'Could not start the top-up'));
    },
  });

  const followHandle = (handle: CheckoutHandle) => {
    if (handle.kind === 'redirect') navigateExternal(handle.url);
    else if (handle.kind === 'iframe') setIframeUrl(handle.iframeUrl);
    else if (handle.kind === 'bank_transfer') setBankRef(handle.instructions.reference);
    qc.invalidateQueries({ queryKey: ['growth-wallet'] });
  };

  const start = useMutation({
    mutationFn: () =>
      quickStart({
        amount: Number(cap),
        ...(targetRoas ? { targetRoas: Number(targetRoas) } : {}),
        arm,
      }),
    onSuccess: (m) => {
      setManifest(m);
      qc.invalidateQueries({ queryKey: ['growth-budgets'] });
      qc.invalidateQueries({ queryKey: ['growth-wallet'] });
      onProvisioned?.(m);
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? t('autopilot.wizard.startError', 'Could not start Autopilot'));
    },
  });

  const steps = [
    { id: 'credit', label: t('autopilot.wizard.stepCredit', 'Credit') },
    { id: 'goal', label: t('autopilot.wizard.stepGoal', 'Cap & goal') },
    { id: 'arm', label: t('autopilot.wizard.stepArm', 'Arm') },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {manifest ? (
          <ManifestScreen manifest={manifest} onClose={() => onOpenChange(false)} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" aria-hidden="true" />
                {t('autopilot.wizard.title', 'Enable Autopilot')}
              </DialogTitle>
              <DialogDescription>
                {t('autopilot.wizard.desc', 'Load credit, set a cap and a goal once — the engine spends it in the most sales-optimal way and never asks again.')}
              </DialogDescription>
            </DialogHeader>

            <Stepper steps={steps} current={step} onStepClick={setStep} aria-label={t('autopilot.wizard.title', 'Enable Autopilot')} />

            {step === 0 && (
              <div className="space-y-4 py-2">
                <div className="flex items-center justify-between rounded-lg border border-border p-4">
                  <div className="flex items-center gap-2">
                    <Wallet className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <span className="text-sm text-muted-foreground">{t('autopilot.wizard.balance', 'Growth credit balance')}</span>
                  </div>
                  <span className="text-lg font-semibold tabular-nums">{money(balance, currency)}</span>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="wizard-topup">{t('autopilot.wizard.topupAmount', 'Top-up amount')}</Label>
                  <div className="flex gap-2">
                    <Input
                      id="wizard-topup"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      value={topupAmount}
                      onChange={(e) => setTopupAmount(e.target.value)}
                      placeholder="5000"
                    />
                    <Button
                      variant="secondary"
                      disabled={!(Number(topupAmount) > 0) || topup.isPending}
                      onClick={() => topup.mutate()}
                    >
                      {topup.isPending ? t('autopilot.wizard.loading', 'Loading…') : t('autopilot.wizard.loadCredit', 'Load credit')}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('autopilot.honesty', 'Ad spend is billed by Meta/TikTok on your connected ad account; your credit governs how much the engine commits.')}
                  </p>
                </div>

                {iframeUrl && (
                  /* Same PayTR 3DS sandbox allowlist as the billing page — verified against a real PayTR sandbox transaction. */
                  <iframe
                    src={iframeUrl}
                    className="min-h-[480px] w-full rounded-lg"
                    title="PayTR checkout"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-top-navigation"
                    referrerPolicy="no-referrer"
                  />
                )}
                {bankRef && (
                  <Callout tone="warning" title={t('autopilot.wizard.bankTitle', 'Bank transfer started')}>
                    {t('autopilot.wizard.bankDesc', 'Complete the transfer with reference {{ref}} — your credit loads as soon as the payment is matched.', { ref: bankRef })}
                  </Callout>
                )}
              </div>
            )}

            {step === 1 && (
              <div className="space-y-4 py-2">
                <div className="space-y-1.5">
                  <Label htmlFor="wizard-cap">{t('autopilot.wizard.cap', 'Monthly cap')}</Label>
                  <Input
                    id="wizard-cap"
                    type="number"
                    inputMode="decimal"
                    min={1}
                    value={cap}
                    onChange={(e) => { setCap(e.target.value); setCapTouched(true); }}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('autopilot.wizard.capHint', 'A hard ceiling the engine can never exceed — prefilled from your loaded credit.')}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wizard-roas">{t('autopilot.wizard.goal', 'Target ROAS (optional)')}</Label>
                  <Input
                    id="wizard-roas"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={0.1}
                    value={targetRoas}
                    onChange={(e) => setTargetRoas(e.target.value)}
                    placeholder="2.5"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('autopilot.wizard.goalHint', 'The return the engine optimizes toward; channels below it are not funded from the proven pool.')}
                  </p>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4 py-2">
                <label className="flex items-center justify-between rounded-lg border border-border p-4">
                  <span>
                    <span className="block text-sm font-medium">{t('autopilot.wizard.arm', 'Turn on Autopilot')}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t('autopilot.wizard.armHint', 'The engine reallocates and spends on its own, within your cap. Pause or Kill stop it instantly.')}
                    </span>
                  </span>
                  <Switch checked={arm} onCheckedChange={setArm} aria-label={t('autopilot.wizard.arm', 'Turn on Autopilot')} />
                </label>
                <p className="text-sm text-muted-foreground">
                  {t('autopilot.wizard.summary', '{{cap}} monthly cap · one click provisions your budget and every connected channel.', { cap: money(Number(cap) || 0, currency) })}
                </p>
              </div>
            )}

            <DialogFooter>
              {step > 0 && (
                <Button variant="secondary" onClick={() => setStep(step - 1)}>
                  {t('autopilot.wizard.back', 'Back')}
                </Button>
              )}
              {step < 2 ? (
                <Button onClick={() => setStep(step + 1)}>{t('autopilot.wizard.next', 'Next')}</Button>
              ) : (
                <Button disabled={!(Number(cap) > 0) || start.isPending} onClick={() => start.mutate()}>
                  <Rocket className="mr-1.5 h-4 w-4" aria-hidden="true" />
                  {start.isPending ? t('autopilot.wizard.starting', 'Starting…') : t('autopilot.wizard.start', 'Start Autopilot')}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Success screen: everything the single quick-start call provisioned. */
function ManifestScreen({ manifest, onClose }: { manifest: QuickStartManifest; onClose: () => void }) {
  const { t } = useTranslation('marketing');
  const currency = manifest.wallet.currency;
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Check className="h-5 w-5 text-success" aria-hidden="true" />
          {t('autopilot.wizard.successTitle', 'Autopilot is live')}
        </DialogTitle>
        <DialogDescription>
          {manifest.armed
            ? t('autopilot.wizard.successArmed', 'Everything below was provisioned in one step. The engine is running on its own — every move lands in the Activity Log.')
            : t('autopilot.wizard.successAssisted', 'Everything below was provisioned in one step. Reallocations will wait for your approval until autonomous mode is enabled.')}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 py-2">
        <div className="flex items-center justify-between rounded-lg border border-border px-4 py-3 text-sm">
          <span className="text-muted-foreground">{t('autopilot.wizard.manifestBudget', 'Budget')}</span>
          <span className="flex items-center gap-2">
            <span className="font-medium tabular-nums">{money(manifest.budget.totalAmount, currency)}</span>
            <Badge tone="neutral">{manifest.budget.periodKey}</Badge>
            <Badge tone={manifest.armed ? 'success' : 'info'}>
              {manifest.armed ? t('autopilot.wizard.armedBadge', 'Autonomous') : t('autopilot.wizard.assistedBadge', 'Assisted')}
            </Badge>
          </span>
        </div>
        <div className="rounded-lg border border-border px-4 py-3">
          <p className="mb-2 text-sm text-muted-foreground">
            {t('autopilot.wizard.manifestChannels', '{{n}} connected channel(s) funded', { n: manifest.channels.length })}
          </p>
          <ul className="space-y-1.5">
            {manifest.allocations.map((a) => (
              <li key={a.channel} className="flex items-center justify-between text-sm">
                <span className="font-medium">{CHANNEL_LABEL[a.channel] ?? a.channel}</span>
                <span className="tabular-nums text-muted-foreground">{money(a.plannedAmount, currency)}</span>
              </li>
            ))}
          </ul>
        </div>
        {manifest.contentCampaign && manifest.contentCampaign.count > 0 && (
          <div className="flex items-center justify-between rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
            <span className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
              {t('autopilot.wizard.manifestContent', 'Autonomous content is now running')}
            </span>
            <Badge tone="success">
              {t('autopilot.wizard.manifestContentCount', '{{n}} campaign(s)', { n: manifest.contentCampaign.count })}
            </Badge>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {t('autopilot.honesty', 'Ad spend is billed by Meta/TikTok on your connected ad account; your credit governs how much the engine commits.')}
        </p>
      </div>

      <DialogFooter>
        <Button onClick={onClose}>{t('autopilot.wizard.done', 'Done')}</Button>
      </DialogFooter>
    </>
  );
}
