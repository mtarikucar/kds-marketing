import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { Textarea } from '@/components/ui/Textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { listSocialAccounts, socialQueryKeys } from '../../../../features/marketing/api/socialPosts.service';
import {
  PROGRAMME_GOALS,
  createProgramme,
  programmeKeys,
  type CreateProgrammeInput,
  type ProgrammeGoal,
} from '../../../../features/marketing/api/contentProgramme.service';
import { errorMessage } from './SlotEditor';

// One slot per day at most: the cadence carries a single publish time per
// weekday, and the backend refuses more than seven.
const PER_WEEK = Array.from({ length: 7 }, (_, i) => i + 1);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** The backend's bounds for `weeklyCreditCap` (`@Min(50) @Max(20000)`). */
export const CAP_MIN = 50;
export const CAP_MAX = 20_000;

export interface ProgrammeSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Creating the programme is the ONE gate the design keeps: the owner names
 * it, says what it is about, picks the accounts and a cadence, and from then
 * on the loop runs itself. So the form asks for exactly what the engine
 * cannot guess — nothing about exploration rates or half-lives, which have
 * sane defaults and a PATCH for later.
 *
 * Accounts are a checkbox list rather than a combobox: there are rarely more
 * than a handful, and "which of my five accounts" is a glance at five boxes,
 * not a search.
 */
export function ProgrammeSetupDialog({ open, onOpenChange }: ProgrammeSetupDialogProps) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const id = useId();
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [accountIds, setAccounts] = useState<string[]>([]);
  const [perWeek, setPerWeek] = useState('5');
  const [goal, setGoal] = useState<ProgrammeGoal>('COMPOSITE');
  const [cap, setCap] = useState('600');
  const [timeOfDay, setTime] = useState('18:00');
  const [error, setError] = useState<string | null>(null);

  // The planner's own key, so the list is a cache hit whenever the planner or
  // the Studio's top strip has already asked for it.
  const accountsQ = useQuery({
    queryKey: socialQueryKeys.accounts,
    queryFn: listSocialAccounts,
    enabled: open,
    meta: { silent: true },
  });

  const create = useMutation({
    // Wrapped: react-query hands `mutationFn` a second (context) argument,
    // and the API wrapper must see exactly one.
    mutationFn: (input: CreateProgrammeInput) => createProgramme(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: programmeKeys.root });
      toast.success(t('studio.programme.setup.created', 'Program başladı; ilk slotlar birkaç dakika içinde planlanır.'));
      onOpenChange(false);
    },
    onError: (e) => setError(errorMessage(e, t('studio.programme.setup.failed', 'Program kurulamadı.'))),
  });

  const goalLabel: Record<ProgrammeGoal, string> = {
    ENGAGEMENT: t('studio.programme.goal.ENGAGEMENT', 'Etkileşim — beğeni, yorum, paylaşım oranı'),
    VIEWS: t('studio.programme.goal.VIEWS', 'İzlenme — video izlenmesi ve gösterim'),
    SAVES_SHARES: t('studio.programme.goal.SAVES_SHARES', 'Kaydet & paylaş — saklanan ve iletilen içerik'),
    LEADS: t('studio.programme.goal.LEADS', 'Müşteri adayı — formdan gelen kişiler'),
    COMPOSITE: t('studio.programme.goal.COMPOSITE', 'Bileşik — etkileşim, kaydet-paylaş ve izlenmenin karışımı'),
  };

  const toggle = (accountId: string, on: boolean) =>
    setAccounts((cur) => (on ? [...new Set([...cur, accountId])] : cur.filter((a) => a !== accountId)));

  const submit = () => {
    setError(null);
    const capN = Number(cap);
    if (!name.trim()) return setError(t('studio.programme.setup.needName', 'Programa bir ad verin.'));
    if (!brief.trim()) return setError(t('studio.programme.setup.needBrief', 'Program neyle ilgili? Kısaca yazın.'));
    if (accountIds.length === 0) return setError(t('studio.programme.setup.needAccounts', 'En az bir hesap seçin.'));
    if (!Number.isInteger(capN) || capN < CAP_MIN || capN > CAP_MAX) {
      return setError(t('studio.programme.setup.needCap', 'Haftalık kredi tavanı 50 ile 20000 arasında bir tam sayı olmalı.'));
    }
    if (!TIME_RE.test(timeOfDay)) return setError(t('studio.programme.setup.needTime', 'Saat SS:DD biçiminde olmalı.'));
    create.mutate({
      name: name.trim(),
      brief: brief.trim(),
      accountIds,
      perWeek: Number(perWeek),
      goal,
      weeklyCreditCap: capN,
      timeOfDay,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('studio.programme.setup.title', 'İçerik programını başlat')}</DialogTitle>
          <DialogDescription>
            {t(
              'studio.programme.setup.description',
              'Türlere göre üretir, yayınlar, ölçer ve tutan türlere kayar. Onay kapısı yok; her slot yayına 2 saat kalana kadar düzenlenebilir.',
            )}
          </DialogDescription>
        </DialogHeader>

        {/*
          `noValidate`: the browser's own constraint bubbles are English, not
          announced by every screen reader, and — with a `step` on the cap —
          refuse values the backend accepts. Every rule is checked in `submit`
          instead and reported through the one localized `role="alert"` line.
        */}
        <form
          className="flex flex-col gap-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-name`}>{t('studio.programme.setup.name', 'Ad')}</Label>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} aria-required="true" />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-brief`}>{t('studio.programme.setup.brief', 'Konu / ürün / ton')}</Label>
            <Textarea id={`${id}-brief`} rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} aria-required="true" />
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm font-medium">{t('studio.programme.setup.accounts', 'Hesaplar')}</legend>
            {accountsQ.isLoading && (
              <span className="text-xs text-muted-foreground">{t('common.loading', 'Yükleniyor…')}</span>
            )}
            {accountsQ.isError && (
              <span className="text-xs text-danger">
                {t('studio.programme.setup.accountsError', 'Hesaplar okunamadı.')}
              </span>
            )}
            {accountsQ.data && accountsQ.data.length === 0 && (
              <span className="text-xs text-muted-foreground">
                {t('studio.programme.setup.noAccounts', 'Bağlı hesap yok — önce bir hesap bağlayın.')}
              </span>
            )}
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {(accountsQ.data ?? []).map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={accountIds.includes(a.id)}
                    onCheckedChange={(v) => toggle(a.id, v === true)}
                    aria-label={`${a.network} ${a.displayName}`}
                  />
                  <span className="text-muted-foreground">{a.network}</span>
                  <span>{a.displayName}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-perWeek`}>{t('studio.programme.setup.perWeek', 'Haftalık gönderi (hesap başına)')}</Label>
              <Select value={perWeek} onValueChange={setPerWeek}>
                <SelectTrigger id={`${id}-perWeek`} aria-label={t('studio.programme.setup.perWeek', 'Haftalık gönderi (hesap başına)')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PER_WEEK.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-goal`}>{t('studio.programme.setup.goal', 'Neyi "tutan" sayalım?')}</Label>
              <Select value={goal} onValueChange={(v) => setGoal(v as ProgrammeGoal)}>
                <SelectTrigger id={`${id}-goal`} aria-label={t('studio.programme.setup.goal', 'Neyi "tutan" sayalım?')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROGRAMME_GOALS.map((g) => (
                    <SelectItem key={g} value={g}>
                      {goalLabel[g]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-cap`}>{t('studio.programme.setup.cap', 'Haftalık kredi tavanı')}</Label>
              <Input
                id={`${id}-cap`}
                type="number"
                min={CAP_MIN}
                max={CAP_MAX}
                step={1}
                value={cap}
                onChange={(e) => setCap(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              {/*
                The engine schedules every slot in Europe/Istanbul whatever the
                browser's zone is, and the strip then prints the chips in the
                browser's — so the label says which clock this field is on.
              */}
              <Label htmlFor={`${id}-time`}>{t('studio.programme.setup.time', 'Yayın saati (Türkiye saati, SS:DD)')}</Label>
              <Input
                id={`${id}-time`}
                type="time"
                value={timeOfDay}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel', 'Vazgeç')}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t('studio.programme.setup.submit', 'Başlat')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default ProgrammeSetupDialog;
