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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';
import { useLeadOptions } from '../hooks';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (leadId: string, role: string) => void;
  isPending: boolean;
}

/** Add a Lead as a community member (MEMBER or MODERATOR). */
export function JoinMemberDialog({ open, onOpenChange, onConfirm, isPending }: Props) {
  const { t } = useTranslation('marketing');
  const [search, setSearch] = useState('');
  const [leadId, setLeadId] = useState('');
  const [role, setRole] = useState('MEMBER');
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
          setRole('MEMBER');
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('memberships.members.addTitle', { defaultValue: 'Add member' })}</DialogTitle>
          <DialogDescription>
            {t('memberships.members.addDesc', { defaultValue: 'Add a lead to this community.' })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label={t('memberships.members.lead', { defaultValue: 'Lead' })} required>
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
                  aria-label={t('memberships.members.lead', { defaultValue: 'Lead' })}
                  placeholder={
                    isLoading
                      ? t('common.loading', { defaultValue: 'Loading…' })
                      : t('memberships.enroll.selectLead', { defaultValue: 'Select a lead' })
                  }
                />
              </div>
            )}
          </Field>

          <Field label={t('memberships.members.role', { defaultValue: 'Role' })}>
            {({ id }) => (
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MEMBER">{t('memberships.members.roles.MEMBER', { defaultValue: 'Member' })}</SelectItem>
                  <SelectItem value="MODERATOR">{t('memberships.members.roles.MODERATOR', { defaultValue: 'Moderator' })}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </Field>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button type="button" disabled={!leadId} loading={isPending} onClick={() => onConfirm(leadId, role)}>
            {t('memberships.members.add', { defaultValue: 'Add member' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
