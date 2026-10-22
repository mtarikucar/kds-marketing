import { useTranslation } from 'react-i18next';
import { Callout } from '@/components/ui';
import { errorMessage } from '@/lib/errors';

/** A failed request, in the panel's words; renders nothing without an error. */
export function ErrorCallout({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  return <Callout tone="danger">{errorMessage(t, error)}</Callout>;
}
