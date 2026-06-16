import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Inbox } from 'lucide-react';
import marketingApi from '../../../../features/marketing/api/marketingApi';
import { fmtDateTime } from '../../../../features/marketing/utils/format';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  Button,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  EmptyState,
  Skeleton,
} from '@/components/ui';
import type { Survey, SurveyResponse } from '../types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  survey: Survey | null;
}

function formatAnswer(value: unknown): string {
  if (value == null) return '—';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function SurveyResponsesDialog({ open, onOpenChange, survey }: Props) {
  const { t } = useTranslation('marketing');

  const { data, isLoading } = useQuery({
    queryKey: ['marketing', 'surveys', survey?.id, 'responses'],
    enabled: open && !!survey?.id,
    queryFn: () =>
      marketingApi.get(`/surveys/${survey!.id}/responses`).then((r) => r.data as SurveyResponse[]),
  });

  const responses: SurveyResponse[] = Array.isArray(data) ? data : [];
  const questions = survey?.questions ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t('surveys.responsesTitle', { defaultValue: 'Responses' })}
            {survey ? ` — ${survey.name}` : ''}
          </DialogTitle>
          <DialogDescription>
            {t('surveys.responsesDesc', { defaultValue: 'The most recent responses for this survey.' })}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : responses.length === 0 ? (
          <EmptyState
            icon={<Inbox className="h-10 w-10" />}
            title={t('surveys.responsesEmpty', { defaultValue: 'No responses yet' })}
            description={t('surveys.responsesEmptyHint', {
              defaultValue: 'Responses appear here once the survey is published and submitted.',
            })}
          />
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <Table>
              <THead>
                <TR>
                  <TH>{t('surveys.submittedAt', { defaultValue: 'Submitted' })}</TH>
                  {questions.map((q) => (
                    <TH key={q.key}>{q.label || q.key}</TH>
                  ))}
                </TR>
              </THead>
              <TBody>
                {responses.map((resp) => (
                  <TR key={resp.id}>
                    <TD className="whitespace-nowrap text-sm text-muted-foreground">
                      {fmtDateTime(resp.createdAt)}
                    </TD>
                    {questions.map((q) => (
                      <TD key={q.key} className="text-sm text-foreground">
                        {formatAnswer((resp.answers ?? {})[q.key])}
                      </TD>
                    ))}
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close', { defaultValue: 'Close' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
