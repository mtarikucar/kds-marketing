import { useForm } from 'react-hook-form';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import marketingApi from '../../features/marketing/api/marketingApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';

interface TelephonyConfigView {
  status: string;
  trunk?: string | null;
  pbxnum?: string | null;
  configuredSecrets: string[];
}

interface TelephonyFormValues {
  username: string;
  password: string;
  trunk: string;
  pbxnum: string;
}

export default function TelephonySettingsPage() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();

  const { data: cfg } = useQuery<TelephonyConfigView | null>({
    queryKey: ['marketing', 'telephony', 'config'],
    queryFn: () => marketingApi.get('/telephony/config').then((r) => r.data),
  });

  const form = useForm<TelephonyFormValues>({
    defaultValues: {
      username: '',
      password: '',
      trunk: cfg?.trunk ?? '',
      pbxnum: cfg?.pbxnum ?? '',
    },
  });

  const save = useMutation({
    mutationFn: (v: TelephonyFormValues) =>
      marketingApi.put('/telephony/config', {
        secrets: {
          ...(v.username ? { username: v.username } : {}),
          ...(v.password ? { password: v.password } : {}),
        },
        trunk: v.trunk || undefined,
        pbxnum: v.pbxnum || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['marketing', 'telephony', 'config'] });
      toast.success(t('telephony.saved', 'Saved'));
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
    </div>
  );
}
