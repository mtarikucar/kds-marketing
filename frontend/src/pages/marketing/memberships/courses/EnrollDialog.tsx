import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  Button,
  Field,
  Combobox,
} from '@/components/ui';
import { useLeadOptions } from '../hooks';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (leadId: string) => void;
  isPending: boolean;
}

/** Pick a Lead (contact) to enroll into the course. */
export function EnrollDialog({ open, onOpenChange, onConfirm, isPending }: Props) {
  const { t } = useTranslation('marketing');
  const [search, setSearch] = useState('');
  const [leadId, setLeadId] = useState('');
  const { data: leads, isLoading } = useLeadOptions(search);

  const options = (leads ?? []).map((l) => ({
    value: l.id,
    label: l.businessName || l.contactPerson || l.id,
  }));

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setLeadId('');
          setSearch('');
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('memberships.enroll.title', { defaultValue: 'Enroll a member' })}</DialogTitle>
          <DialogDescription>
            {t('memberships.enroll.desc', { defaultValue: 'Pick a lead to enroll into this course.' })}
          </DialogDescription>
        </DialogHeader>

        <Field label={t('memberships.enroll.lead', { defaultValue: 'Lead' })} required>
          {() => (
            <div className="space-y-2">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('memberships.enroll.searchPlaceholder', { defaultValue: 'Search leads…' })}
                className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-[--ring]"
              />
              <Combobox
                options={options}
                value={leadId}
                onChange={setLeadId}
                aria-label={t('memberships.enroll.lead', { defaultValue: 'Lead' })}
                placeholder={
                  isLoading
                    ? t('common.loading', { defaultValue: 'Loading…' })
                    : t('memberships.enroll.selectLead', { defaultValue: 'Select a lead' })
                }
              />
            </div>
          )}
        </Field>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button type="button" disabled={!leadId} loading={isPending} onClick={() => onConfirm(leadId)}>
            {t('memberships.enroll.confirm', { defaultValue: 'Enroll' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
