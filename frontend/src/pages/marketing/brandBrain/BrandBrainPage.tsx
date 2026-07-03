import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { BrainCircuit, Search, RefreshCw, FileText } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { Callout } from '@/components/ui/Callout';
import { searchBrandBrain, reindexBrandBrain, type Citation } from '../../../features/marketing/api/brandBrain.service';

/**
 * Brand Brain (Faz 1) — ask over your own knowledge base and get answers grounded
 * in your sources, each with a citation back to the doc. Keyword + citation
 * today; semantic re-rank lights up once an embedding provider is configured.
 */
export default function BrandBrainPage() {
  const { t } = useTranslation('marketing');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Citation[] | null>(null);

  const search = useMutation({
    mutationFn: () => searchBrandBrain(query.trim()),
    onSuccess: setResults,
    onError: () => toast.error(t('brain.searchError', 'Search failed')),
  });

  const reindex = useMutation({
    mutationFn: reindexBrandBrain,
    onSuccess: (r) => toast.success(t('brain.reindexed', 'Reindexed {{docs}} doc(s) into {{chunks}} chunk(s)', r)),
    onError: () => toast.error(t('brain.reindexError', 'Reindex failed')),
  });

  const submit = () => query.trim() && search.mutate();

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('brain.title', 'Brand Brain')}
        description={t('brain.subtitle', 'Grounded, cited answers from your own knowledge base — never made up.')}
        actions={
          <Button variant="secondary" onClick={() => reindex.mutate()} disabled={reindex.isPending}>
            <RefreshCw className={`mr-1.5 h-4 w-4 ${reindex.isPending ? 'animate-spin' : ''}`} />
            {t('brain.reindex', 'Reindex')}
          </Button>
        }
      />

      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder={t('brain.placeholder', 'Ask about your brand, offers, past campaigns…')}
          aria-label={t('brain.title', 'Brand Brain')}
        />
        <Button onClick={submit} disabled={!query.trim() || search.isPending}>
          <Search className="mr-1.5 h-4 w-4" />{search.isPending ? t('brain.searching', 'Searching…') : t('brain.search', 'Search')}
        </Button>
      </div>

      {reindex.isError && (
        <Callout
          tone="danger"
          title={t('brain.reindexError.title', 'Reindex failed')}
        >
          <div className="flex flex-col gap-2">
            <p>{t('brain.reindexError.desc', 'We couldn’t rebuild the search index. Your existing docs are unaffected — please try again.')}</p>
            <div>
              <Button size="sm" variant="secondary" onClick={() => reindex.mutate()} disabled={reindex.isPending}>
                <RefreshCw className={`mr-1.5 h-4 w-4 ${reindex.isPending ? 'animate-spin' : ''}`} aria-hidden="true" />
                {t('common.retry', 'Try again')}
              </Button>
            </div>
          </div>
        </Callout>
      )}

      {search.isError ? (
        <EmptyState
          icon={<Search className="h-6 w-6" />}
          title={t('brain.searchError.title', 'Search failed')}
          description={t('brain.searchError.desc', 'Something went wrong running that search. Please try again.')}
          action={
            <Button onClick={() => search.mutate()} disabled={search.isPending}>
              <Search className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {t('common.retry', 'Try again')}
            </Button>
          }
        />
      ) : results === null ? (
        <EmptyState
          icon={<BrainCircuit className="h-6 w-6" />}
          title={t('brain.start.title', 'Ask your Brand Brain')}
          description={t('brain.start.desc', 'Every answer is grounded in your knowledge docs and cites its source. Search is keyword-based until an admin configures an embedding provider for smarter, meaning-based matches. Reindex after adding docs so they’re searchable.')}
        />
      ) : results.length === 0 ? (
        <EmptyState
          icon={<Search className="h-6 w-6" />}
          title={t('brain.noResults.title', 'No matches')}
          description={t('brain.noResults.desc', 'Nothing in your knowledge base matched. Try different words, or add & reindex more docs.')}
        />
      ) : (
        <div className="space-y-2">
          {results.map((c) => (
            <Card key={c.chunkId}>
              <CardContent className="space-y-1.5 py-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    {c.docTitle || t('brain.untitled', 'Untitled source')}
                  </span>
                  {c.score > 0 && (
                    <Badge
                      tone="neutral"
                      title={t('brain.scoreTip', 'Relevance score — how closely this passage matches your query')}
                      aria-label={t('brain.scoreAria', 'Relevance {{n}}', { n: c.score.toFixed(2) })}
                    >
                      {c.score.toFixed(2)}
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">{c.snippet}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
