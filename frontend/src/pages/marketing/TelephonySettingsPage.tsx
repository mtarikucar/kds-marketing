import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import marketingApi from '../../features/marketing/api/marketingApi';
import TestWebphonePanel from '../../features/marketing/webphone/TestWebphonePanel';
import { useMarketingAuthStore } from '@/store/marketingAuthStore';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { PhoneInput } from '@/components/ui/PhoneInput';

interface TelephonyConfigView {
  status: string;
  trunk?: string | null;
  pbxnum?: string | null;
  wssUrl?: string | null;
  sipDomain?: string | null;
  configuredSecrets: string[];
}

interface TelephonyFormValues {
  username: string;
  password: string;
  trunk: string;
  pbxnum: string;
  wssUrl: string;
  sipDomain: string;
}

interface DahiliFormValues {
  phone: string;
  dahili: string;
  sipPassword: string;
}

export default function TelephonySettingsPage() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const userId = useMarketingAuthStore((s) => s.user?.id);

  const { data: cfg } = useQuery<TelephonyConfigView | null>({
    queryKey: ['marketing', 'telephony', 'config'],
    queryFn: () => marketingApi.get('/telephony/config').then((r) => r.data),
  });

  const form = useForm<TelephonyFormValues>({
    defaultValues: {
      username: '',
      password: '',
      trunk: '',
      pbxnum: '',
      wssUrl: '',
      sipDomain: '',
    },
  });

  useEffect(() => {
    if (cfg)
      form.reset({
        username: '',
        password: '',
        trunk: cfg.trunk ?? '',
        pbxnum: cfg.pbxnum ?? '',
        wssUrl: cfg.wssUrl ?? '',
        sipDomain: cfg.sipDomain ?? '',
      });
  }, [cfg]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: (v: TelephonyFormValues) =>
      marketingApi.put('/telephony/config', {
        secrets: {
          ...(v.username ? { username: v.username } : {}),
          ...(v.password ? { password: v.password } : {}),
        },
        trunk: v.trunk || undefined,
        pbxnum: v.pbxnum || undefined,
        // Empty strings would fail the wss:// validator — send undefined to
        // keep the stored value untouched on a partial save.
        wssUrl: v.wssUrl || undefined,
        sipDomain: v.sipDomain || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['marketing', 'telephony', 'config'] });
      // The webphone registers only once config + wss/domain are present.
      qc.invalidateQueries({ queryKey: ['marketing', 'telephony', 'webphone-config'] });
      toast.success(t('telephony.saved', 'Saved'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('telephony.saveFailed', 'Save failed')),
  });

  const dahiliForm = useForm<DahiliFormValues>({
    defaultValues: { phone: '', dahili: '', sipPassword: '' },
  });

  const saveDahili = useMutation({
    mutationFn: (v: DahiliFormValues) => {
      if (!userId) throw new Error('not authenticated');
      return marketingApi.patch(`/telephony/users/${userId}/dahili`, {
        phone: v.phone || null,
        dahili: v.dahili || null,
        ...(v.sipPassword ? { sipPassword: v.sipPassword } : {}),
      });
    },
    onSuccess: () => {
      // Re-fetch so the Test Webphone panel picks up the new dahili and registers.
      qc.invalidateQueries({ queryKey: ['marketing', 'telephony', 'webphone-config'] });
      dahiliForm.reset({ phone: dahiliForm.getValues('phone'), dahili: dahiliForm.getValues('dahili'), sipPassword: '' });
      toast.success(t('telephony.dahiliSaved', 'Saved'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('telephony.saveFailed', 'Save failed')),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('telephony.title', 'Phone (Netsantral)')}
        description={t(
          'telephony.subtitle',
          'Place sales calls from your 0850 line via NetGSM Netsantral.',
        )}
      />
      <Card>
        <CardContent className="p-5 space-y-4">
          <form
            onSubmit={form.handleSubmit((v) => save.mutate(v))}
            className="space-y-4"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="username (abone no)">
                {({ id }) => (
                  <Input
                    id={id}
                    placeholder="8508407303"
                    {...form.register('username')}
                  />
                )}
              </Field>
              <Field label="password (API sub-user)">
                {({ id }) => (
                  <Input
                    id={id}
                    type="password"
                    placeholder="••••••••"
                    autoComplete="off"
                    {...form.register('password')}
                  />
                )}
              </Field>
              <Field label="trunk (0850)">
                {({ id }) => (
                  <Input
                    id={id}
                    placeholder="8508407303"
                    {...form.register('trunk')}
                  />
                )}
              </Field>
              <Field label="pbxnum (optional)">
                {({ id }) => <Input id={id} {...form.register('pbxnum')} />}
              </Field>
              <Field label="wssUrl (WebRTC)">
                {({ id }) => (
                  <Input
                    id={id}
                    placeholder="wss://sip5.netsantral.com:8089/ws"
                    {...form.register('wssUrl')}
                  />
                )}
              </Field>
              <Field label="sipDomain">
                {({ id }) => (
                  <Input
                    id={id}
                    placeholder="sip5.netsantral.com"
                    {...form.register('sipDomain')}
                  />
                )}
              </Field>
            </div>
            <p className="text-caption text-muted-foreground">
              {cfg?.configuredSecrets?.length
                ? `${t('telephony.credsSet', 'credentials set')}: ${cfg.configuredSecrets.join(', ')}`
                : t('telephony.noCreds', 'no credentials yet')}
            </p>
            <Button type="submit" loading={save.isPending}>
              {t('common.save', 'Save')}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5 space-y-4">
          <div>
            <p className="font-medium">{t('telephony.myCalling', 'My calling')}</p>
            <p className="text-caption text-muted-foreground">
              {t(
                'telephony.myPhoneHint',
                'Phone (cell): when you click “Call”, NetGSM rings your phone then connects you to the customer over the 0850 line. No softphone/Netsipp needed.',
              )}
            </p>
          </div>
          <form
            onSubmit={dahiliForm.handleSubmit((v) => saveDahili.mutate(v))}
            className="space-y-4"
          >
            <Field label={t('telephony.myPhone', 'My phone (cell)')}>
              {({ id }) => (
                <PhoneInput id={id} {...dahiliForm.register('phone')} />
              )}
            </Field>
            <p className="text-caption text-muted-foreground pt-2">
              {t(
                'telephony.webphoneOptional',
                'In-browser webphone (optional, needs a Netsipp+ license): extension + its SIP password.',
              )}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="dahili">
                {({ id }) => (
                  <Input id={id} placeholder="101" {...dahiliForm.register('dahili')} />
                )}
              </Field>
              <Field label="SIP password">
                {({ id }) => (
                  <Input
                    id={id}
                    type="password"
                    placeholder="••••••••"
                    autoComplete="off"
                    {...dahiliForm.register('sipPassword')}
                  />
                )}
              </Field>
            </div>
            <Button type="submit" loading={saveDahili.isPending} disabled={!userId}>
              {t('common.save', 'Save')}
            </Button>
          </form>
        </CardContent>
      </Card>

      <TestWebphonePanel />
    </div>
  );
}
