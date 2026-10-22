import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui';
import { PERMISSIONS, type Permission } from '@/api/types';

/** Permissions as small badges, in the fixed order of the permission list. */
export function PermissionList({ permissions }: { permissions: readonly Permission[] }) {
  const { t } = useTranslation();
  const held = PERMISSIONS.filter((p) => permissions.includes(p));
  if (held.length === 0) {
    return <span className="text-caption text-muted-foreground">{t('roles.noPermissions')}</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {held.map((p) => (
        <Badge key={p} size="sm" title={p}>
          {t(`permissions.${p}`)}
        </Badge>
      ))}
    </span>
  );
}
