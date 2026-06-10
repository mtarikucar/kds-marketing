import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import marketingApi from '../../features/marketing/api/marketingApi';
import { BusinessType, LeadSource } from '../../features/marketing/types';
import { leadSchema, type LeadFormValues } from '../../features/marketing/schemas';

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

  const inputCls =
    'w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white text-slate-900 focus:ring-2 focus:ring-primary focus:border-primary outline-none disabled:bg-slate-50';
  const errCls = 'mt-1 text-xs text-red-600';
  const labelCls = 'block text-sm text-slate-600 mb-1';
  const sectionTitleCls = 'text-sm font-semibold text-slate-900 mb-3';

  const fieldErr = (msg?: string) =>
    msg
      ? // Translation lookup; falls back to the raw message for any
        // backend-supplied string (e.g. duplicate-email error).
        t([`validation.${msg}`, msg], { defaultValue: msg })
      : null;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-0 pb-12">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">
          {isEdit ? t('createLead.titleEdit') : t('createLead.titleNew')}
        </h1>
        <p className="text-sm text-slate-500 mt-1">{t('createLead.subtitle')}</p>
      </div>

      <form
        onSubmit={form.handleSubmit(onSubmit)}
        noValidate
        className="bg-white rounded-xl border border-slate-200 p-6 space-y-6"
      >
        {/* Business */}
        <section>
          <h3 className={sectionTitleCls}>{t('createLead.sections.business')}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>{t('createLead.fields.businessName')} *</label>
              <input type="text" {...form.register('businessName')} className={inputCls} />
              {form.formState.errors.businessName && (
                <p className={errCls}>{fieldErr(form.formState.errors.businessName.message)}</p>
              )}
            </div>
            <div>
              <label className={labelCls}>{t('createLead.fields.businessType')} *</label>
              <select {...form.register('businessType')} className={inputCls}>
                {Object.values(BusinessType).map((b) => (
                  <option key={b} value={b}>
                    {t(`businessType.${b}`)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>{t('createLead.fields.tableCount')}</label>
              <input
                type="number"
                min={0}
                {...form.register('tableCount')}
                className={inputCls}
              />
              {form.formState.errors.tableCount && (
                <p className={errCls}>{fieldErr(form.formState.errors.tableCount.message)}</p>
              )}
            </div>
            <div>
              <label className={labelCls}>{t('createLead.fields.branchCount')}</label>
              <input
                type="number"
                min={0}
                {...form.register('branchCount')}
                className={inputCls}
              />
              {form.formState.errors.branchCount && (
                <p className={errCls}>{fieldErr(form.formState.errors.branchCount.message)}</p>
              )}
            </div>
            <div className="sm:col-span-2">
              <label className={labelCls}>{t('createLead.fields.currentSystem')}</label>
              <input type="text" {...form.register('currentSystem')} className={inputCls} />
            </div>
          </div>
        </section>

        {/* Contact */}
        <section>
          <h3 className={sectionTitleCls}>{t('createLead.sections.contact')}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>{t('createLead.fields.contactPerson')} *</label>
              <input type="text" {...form.register('contactPerson')} className={inputCls} />
              {form.formState.errors.contactPerson && (
                <p className={errCls}>{fieldErr(form.formState.errors.contactPerson.message)}</p>
              )}
            </div>
            <div>
              <label className={labelCls}>{t('createLead.fields.phone')}</label>
              <input
                type="tel"
                {...form.register('phone')}
                placeholder="+90555..."
                className={inputCls}
              />
              {form.formState.errors.phone && (
                <p className={errCls}>{fieldErr(form.formState.errors.phone.message)}</p>
              )}
            </div>
            <div>
              <label className={labelCls}>{t('createLead.fields.whatsapp')}</label>
              <input
                type="tel"
                {...form.register('whatsapp')}
                placeholder="+90555..."
                className={inputCls}
              />
              {form.formState.errors.whatsapp && (
                <p className={errCls}>{fieldErr(form.formState.errors.whatsapp.message)}</p>
              )}
            </div>
            <div>
              <label className={labelCls}>{t('createLead.fields.email')}</label>
              <input type="email" {...form.register('email')} className={inputCls} />
              {form.formState.errors.email && (
                <p className={errCls}>{fieldErr(form.formState.errors.email.message)}</p>
              )}
            </div>
          </div>
        </section>

        {/* Location */}
        <section>
          <h3 className={sectionTitleCls}>{t('createLead.sections.location')}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className={labelCls}>{t('createLead.fields.city')}</label>
              <input type="text" {...form.register('city')} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>{t('createLead.fields.region')}</label>
              <input type="text" {...form.register('region')} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>{t('createLead.fields.address')}</label>
              <input type="text" {...form.register('address')} className={inputCls} />
            </div>
          </div>
        </section>

        {/* Lead info */}
        <section>
          <h3 className={sectionTitleCls}>{t('createLead.sections.lead')}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className={labelCls}>{t('createLead.fields.source')} *</label>
              <select {...form.register('source')} className={inputCls}>
                {Object.values(LeadSource).map((s) => (
                  <option key={s} value={s}>
                    {t(`source.${s}`)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>{t('createLead.fields.priority')}</label>
              <select {...form.register('priority')} className={inputCls}>
                {['LOW', 'MEDIUM', 'HIGH', 'URGENT'].map((p) => (
                  <option key={p} value={p}>
                    {t(`priority.${p}`)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>{t('createLead.fields.nextFollowUp')}</label>
              <input type="date" {...form.register('nextFollowUp')} className={inputCls} />
            </div>
          </div>
          <div className="mt-4">
            <label className={labelCls}>{t('createLead.fields.notes')}</label>
            <textarea
              rows={3}
              {...form.register('notes')}
              className={`${inputCls} resize-none`}
            />
          </div>
        </section>

        {/* Actions */}
        <div className="flex gap-3 pt-4 border-t border-slate-200">
          <button
            type="submit"
            disabled={mutation.isPending}
            className="inline-flex items-center gap-2 px-6 py-2.5 bg-primary text-primary-foreground rounded-lg font-medium text-sm hover:bg-primary/90 disabled:opacity-60 transition"
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {isEdit ? t('createLead.submitUpdate') : t('createLead.submitCreate')}
          </button>
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="px-6 py-2.5 border border-slate-300 rounded-lg text-sm hover:bg-slate-50 transition"
          >
            {t('common.cancel')}
          </button>
        </div>
      </form>
    </div>
  );
}
