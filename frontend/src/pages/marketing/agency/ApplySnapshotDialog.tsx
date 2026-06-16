import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CheckCircle2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  Button,
  Field,
  Badge,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui';
import { useSnapshotMutations } from './hooks';
import { SNAPSHOT_CONFIG_TYPES, type ApplyResult, type Location, type SnapshotListItem } from './types';
import { apiError } from './util';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: SnapshotListItem | null;
  /** Child locations the snapshot can be applied TO. */
  locations: Location[];
}

export function ApplySnapshotDialog({ open, onOpenChange, snapshot, locations }: Props) {
  const { t } = useTranslation('marketing');
  const { apply } = useSnapshotMutations();

  const [locationId, setLocationId] = useState('');
  const [result, setResult] = useState<ApplyResult | null>(null);

  // Reset transient state whenever the dialog (re)opens or target snapshot changes.
  useEffect(() => {
    if (open) {
      setLocationId('');
      setResult(null);
    }
  }, [open, snapshot?.id]);

  const handleApply = () => {
    if (!snapshot || !locationId) return;
    apply.mutate(
      { snapshotId: snapshot.id, locationId },
      {
        onSuccess: (res) => {
          setResult(res);
          toast.success(t('agency.snapshots.applied', { defaultValue: 'Snapshot applied' }));
        },
        onError: (e) => toast.error(apiError(e, t('agency.snapshots.applyError', { defaultValue: 'Failed to apply snapshot' }))),
      },
    );
  };

  const totalCreated = result
    ? SNAPSHOT_CONFIG_TYPES.reduce((sum, k) => sum + (result.summary[k]?.created ?? 0), 0)
    : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('agency.snapshots.applyTitle', { defaultValue: 'Apply snapshot' })}</DialogTitle>
          <DialogDescription>
            {snapshot
              ? t('agency.snapshots.applyDesc', {
                  defaultValue: 'Clone “{{name}}” into a child location. Existing config is kept (skipped), so re-applying is safe.',
                  name: snapshot.name,
                })
              : ''}
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-success">
              <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
              <p className="text-sm font-medium">
                {t('agency.snapshots.resultHeading', {
                  defaultValue: '{{count}} item(s) created across config types.',
                  count: totalCreated,
                })}
              </p>
            </div>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {SNAPSHOT_CONFIG_TYPES.map((type) => {
                const s = result.summary[type] ?? { created: 0, skipped: 0 };
                return (
                  <li key={type} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span className="text-foreground">{t(`agency.snapshots.types.${type}`, { defaultValue: type })}</span>
                    <span className="flex items-center gap-2">
                      <Badge tone="success" size="sm">
                        {t('agency.snapshots.created', { defaultValue: 'Created' })}: {s.created}
                      </Badge>
                      <Badge tone="neutral" size="sm">
                        {t('agency.snapshots.skipped', { defaultValue: 'Skipped' })}: {s.skipped}
                      </Badge>
                    </span>
                  </li>
                );
              })}
            </ul>
            <DialogFooter>
              <Button type="button" onClick={() => onOpenChange(false)}>
                {t('common.done', { defaultValue: 'Done' })}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <Field label={t('agency.snapshots.targetLocation', { defaultValue: 'Target location' })} required>
              {({ id }) => (
                <Select value={locationId} onValueChange={setLocationId}>
                  <SelectTrigger id={id}>
                    <SelectValue placeholder={t('agency.snapshots.pickLocation', { defaultValue: 'Choose a location…' })} />
                  </SelectTrigger>
                  <SelectContent>
                    {locations.map((loc) => (
                      <SelectItem key={loc.id} value={loc.id}>
                        {loc.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={apply.isPending}>
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </Button>
              <Button type="button" onClick={handleApply} loading={apply.isPending} disabled={!locationId}>
                {t('agency.snapshots.apply', { defaultValue: 'Apply' })}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
