import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useForm, type SubmitHandler, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { BusinessType, LeadSource } from '../../features/marketing/types';
import { leadSchema, type LeadFormValues } from '../../features/marketing/schemas';
import {
  PageHeader,
  Card,
  CardContent,
  Field,
  Input,
  Textarea,
  Button,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  IconButton,
} from '@/components/ui';

/**
 * Lead create/edit form. Route param `id` switches into edit mode
 * and the form preloads from `/leads/:id`. Validation is zod-driven;
 * the schema mirrors the backend DTO so payloads that pass here are
 * always shape-correct on the server too (the server stays the
 * source of truth — these checks just shorten the feedback loop).
 */
export default function CreateLeadPage() {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation('marketing');
  const isEdit = !!id;

  const form = useForm<LeadFormValues>({
    resolver: zodResolver(leadSchema),
    mode: 'onBlur',
    defaultValues: {
      businessName: '',
      contactPerson: '',
      businessType: 'RESTAURANT',
      source: 'PHONE',
      priority: 'MEDIUM',
      phone: '',
      whatsapp: '',
      email: '',
      address: '',
      city: '',
      region: '',
      tableCount: '',
      branchCount: '',
      currentSystem: '',
      notes: '',
      nextFollowUp: '',
    },
  });

  const { data: existingLead } = useQuery({
    queryKey: ['marketing', 'lead', id],
    queryFn: () => marketingApi.get(`/leads/${id}`).then((r) => r.data),
    enabled: isEdit,
  });

  useEffect(() => {
    if (existingLead) {
      form.reset({
        businessName: existingLead.businessName || '',
        contactPerson: existingLead.contactPerson || '',
        businessType: existingLead.businessType || 'RESTAURANT',
        source: existingLead.source || 'PHONE',
        priority: existingLead.priority || 'MEDIUM',
        phone: existingLead.phone || '',
        whatsapp: existingLead.whatsapp || '',
        email: existingLead.email || '',
        address: existingLead.address || '',
        city: existingLead.city || '',
        region: existingLead.region || '',
        tableCount: existingLead.tableCount?.toString() || '',
        branchCount: existingLead.branchCount?.toString() || '',
        currentSystem: existingLead.currentSystem || '',
        notes: existingLead.notes || '',
        nextFollowUp: existingLead.nextFollowUp ? existingLead.nextFollowUp.split('T')[0] : '',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingLead]);

  const mutation = useMutation({
    mutationFn: (data: unknown) =>
      isEdit
        ? marketingApi.patch(`/leads/${id}`, data)
        : marketingApi.post('/leads', data),
    onSuccess: (res) => {
      const leadId = isEdit ? id : res.data.id;
      toast.success(isEdit ? t('createLead.updateSuccess') : t('createLead.createSuccess'));
      navigate(`/leads/${leadId}`);
    },
    onError: (err: any) => {
      const message = err.response?.data?.message;
      // Backend 409 on duplicate email — surface as a field-level
      // error rather than a generic toast.
      if (err.response?.status === 409 && /email/i.test(message ?? '')) {
        form.setError('email', { message: t('createLead.duplicateEmailError') });
        return;
      }
      toast.error(message || t('common.noData'));
    },
  });

  const onSubmit: SubmitHandler<LeadFormValues> = (values) => {
    // Strip empty optional strings so the backend doesn't store "".
    const payload: Record<string, unknown> = {
      businessName: values.businessName.trim(),
      contactPerson: values.contactPerson.trim(),
      businessType: values.businessType,
      source: values.source,
      priority: values.priority,
    };
    if (values.phone) payload.phone = values.phone.trim();
    if (values.whatsapp) payload.whatsapp = values.whatsapp.trim();
    if (values.email) payload.email = values.email.trim();
    if (values.address) payload.address = values.address.trim();
    if (values.city) payload.city = values.city.trim();
    if (values.region) payload.region = values.region.trim();
    if (values.tableCount) payload.tableCount = parseInt(values.tableCount, 10);
    if (values.branchCount) payload.branchCount = parseInt(values.branchCount, 10);
    if (values.currentSystem) payload.currentSystem = values.currentSystem.trim();
    if (values.notes) payload.notes = values.notes.trim();
    if (values.nextFollowUp) payload.nextFollowUp = values.nextFollowUp;
    mutation.mutate(payload);
  };

  const fieldErr = (msg?: string) =>
    msg
      ? // Translation lookup; falls back to the raw message for any
        // backend-supplied string (e.g. duplicate-email error).
        t([`validation.${msg}`, msg], { defaultValue: msg })
      : undefined;

  const errors = form.formState.errors;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-0 pb-12 space-y-6">
      <PageHeader
        title={isEdit ? t('createLead.titleEdit') : t('createLead.titleNew')}
        description={t('createLead.subtitle')}
        actions={
          <IconButton
            aria-label={t('common.back')}
            onClick={() => navigate(-1)}
            variant="ghost"
            size="sm"
          >
            <ArrowLeft className="h-4 w-4" />
          </IconButton>
        }
      />

      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <Card>
          <CardContent className="pt-5 space-y-8">
            {/* Business */}
            <section>
              <h3 className="text-sm font-semibold text-foreground mb-4">
                {t('createLead.sections.business')}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field
                  label={t('createLead.fields.businessName')}
                  required
                  error={fieldErr(errors.businessName?.message)}
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      aria-invalid={invalid || undefined}
                      {...form.register('businessName')}
                    />
                  )}
                </Field>

                <Field
                  label={t('createLead.fields.businessType')}
                  required
                  error={fieldErr(errors.businessType?.message)}
                >
                  {({ id, invalid }) => (
                    <Controller
                      control={form.control}
                      name="businessType"
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger
                            id={id}
                            aria-invalid={invalid || undefined}
                            ref={field.ref}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {Object.values(BusinessType).map((b) => (
                              <SelectItem key={b} value={b}>
                                {t(`businessType.${b}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  )}
                </Field>

                <Field
                  label={t('createLead.fields.tableCount')}
                  error={fieldErr(errors.tableCount?.message)}
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      type="number"
                      min={0}
                      aria-describedby={describedBy}
                      aria-invalid={invalid || undefined}
                      {...form.register('tableCount')}
                    />
                  )}
                </Field>

                <Field
                  label={t('createLead.fields.branchCount')}
                  error={fieldErr(errors.branchCount?.message)}
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      type="number"
                      min={0}
                      aria-describedby={describedBy}
                      aria-invalid={invalid || undefined}
                      {...form.register('branchCount')}
                    />
                  )}
                </Field>

                <div className="sm:col-span-2">
                  <Field label={t('createLead.fields.currentSystem')}>
                    {({ id }) => (
                      <Input id={id} {...form.register('currentSystem')} />
                    )}
                  </Field>
                </div>
              </div>
            </section>

            {/* Contact */}
            <section>
              <h3 className="text-sm font-semibold text-foreground mb-4">
                {t('createLead.sections.contact')}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field
                  label={t('createLead.fields.contactPerson')}
                  required
                  error={fieldErr(errors.contactPerson?.message)}
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      aria-describedby={describedBy}
                      aria-invalid={invalid || undefined}
                      {...form.register('contactPerson')}
                    />
                  )}
                </Field>

                <Field
                  label={t('createLead.fields.phone')}
                  error={fieldErr(errors.phone?.message)}
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      type="tel"
                      placeholder="+90555..."
                      aria-describedby={describedBy}
                      aria-invalid={invalid || undefined}
                      {...form.register('phone')}
                    />
                  )}
                </Field>

                <Field
                  label={t('createLead.fields.whatsapp')}
                  error={fieldErr(errors.whatsapp?.message)}
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      type="tel"
                      placeholder="+90555..."
                      aria-describedby={describedBy}
                      aria-invalid={invalid || undefined}
                      {...form.register('whatsapp')}
                    />
                  )}
                </Field>

                <Field
                  label={t('createLead.fields.email')}
                  error={fieldErr(errors.email?.message)}
                >
                  {({ id, describedBy, invalid }) => (
                    <Input
                      id={id}
                      type="email"
                      aria-describedby={describedBy}
                      aria-invalid={invalid || undefined}
                      {...form.register('email')}
                    />
                  )}
                </Field>
              </div>
            </section>

            {/* Location */}
            <section>
              <h3 className="text-sm font-semibold text-foreground mb-4">
                {t('createLead.sections.location')}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <Field label={t('createLead.fields.city')}>
                  {({ id }) => <Input id={id} {...form.register('city')} />}
                </Field>

                <Field label={t('createLead.fields.region')}>
                  {({ id }) => <Input id={id} {...form.register('region')} />}
                </Field>

                <Field label={t('createLead.fields.address')}>
                  {({ id }) => <Input id={id} {...form.register('address')} />}
                </Field>
              </div>
            </section>

            {/* Lead info */}
            <section>
              <h3 className="text-sm font-semibold text-foreground mb-4">
                {t('createLead.sections.lead')}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <Field
                  label={t('createLead.fields.source')}
                  required
                  error={fieldErr(errors.source?.message)}
                >
                  {({ id, invalid }) => (
                    <Controller
                      control={form.control}
                      name="source"
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger
                            id={id}
                            aria-invalid={invalid || undefined}
                            ref={field.ref}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {Object.values(LeadSource).map((s) => (
                              <SelectItem key={s} value={s}>
                                {t(`source.${s}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  )}
                </Field>

                <Field
                  label={t('createLead.fields.priority')}
                  error={fieldErr(errors.priority?.message)}
                >
                  {({ id, invalid }) => (
                    <Controller
                      control={form.control}
                      name="priority"
                      render={({ field }) => (
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger
                            id={id}
                            aria-invalid={invalid || undefined}
                            ref={field.ref}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => (
                              <SelectItem key={p} value={p}>
                                {t(`priority.${p}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  )}
                </Field>

                <Field label={t('createLead.fields.nextFollowUp')}>
                  {({ id }) => (
                    <Input id={id} type="date" {...form.register('nextFollowUp')} />
                  )}
                </Field>
              </div>

              <div className="mt-4">
                <Field label={t('createLead.fields.notes')}>
                  {({ id }) => (
                    <Textarea id={id} rows={3} {...form.register('notes')} />
                  )}
                </Field>
              </div>
            </section>

            {/* Actions */}
            <div className="flex gap-3 pt-2 border-t border-border">
              <Button type="submit" loading={mutation.isPending}>
                {isEdit ? t('createLead.submitUpdate') : t('createLead.submitCreate')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate(-1)}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </form>
    </div>
  );
}
