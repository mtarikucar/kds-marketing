import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Key, Clipboard } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Callout } from '@/components/ui/Callout';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

// ── Types ─────────────────────────────────────────────────────────────────────

interface IngestTokenRow {
  id: string;
  tokenPrefix: string;
  label: string;
  status: 'ACTIVE' | 'REVOKED';
  lastUsedAt?: string | null;
  createdAt: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function IngestTokensCard() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();

  const [tokenLabel, setTokenLabel] = useState('');
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<IngestTokenRow | null>(null);

  const { data: tokens } = useQuery<IngestTokenRow[]>({
    queryKey: ['marketing', 'research', 'tokens'],
    queryFn: () => marketingApi.get('/research/tokens').then((r) => r.data),
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'research', 'tokens'] });

  const mintToken = useMutation({
    mutationFn: () => marketingApi.post('/research/tokens', { label: tokenLabel }),
    onSuccess: ({ data }) => {
      setMintedToken(data.token);
      setTokenLabel('');
      invalidate();
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? 'Mint failed'),
  });

  const revokeToken = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/research/tokens/${id}`),
    onSuccess: () => {
      invalidate();
      setRevokeTarget(null);
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('research.revokeFailed', 'Could not revoke the token')),
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Key className="h-5 w-5 text-muted-foreground" />
          <h2 className="font-display text-h3 text-foreground">
            {t('research.tokens', 'Ingest tokens')}
          </h2>
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            'research.tokensHint',
            'For pushing leads from your own integrations (POST /api/marketing/leads/ingest with the x-ingest-token header). The platform research agent does not need one.',
          )}
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        {mintedToken && (
          <Callout tone="warning" title={t('research.tokenOnce', 'Copy this token now — it will never be shown again.')}>
            <div className="flex items-center gap-2 mt-2">
              <code className="text-xs bg-surface border border-border rounded px-2 py-1.5 flex-1 break-all">
                {mintedToken}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(mintedToken);
                  toast.success(t('common.copied', 'Copied'));
                }}
              >
                <Clipboard className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setMintedToken(null)}
              >
                {t('common.done', 'Done')}
              </Button>
            </div>
          </Callout>
        )}

        <div className="flex gap-2">
          <Input
            value={tokenLabel}
            onChange={(e) => setTokenLabel(e.target.value)}
            maxLength={120}
            placeholder={t('research.tokenLabel', 'Label (e.g. zapier-integration)')}
            className="flex-1"
          />
          <Button
            onClick={() => mintToken.mutate()}
            disabled={!tokenLabel}
            loading={mintToken.isPending}
            variant="secondary"
            size="md"
          >
            {t('research.mint', 'Create token')}
          </Button>
        </div>

        <div className="divide-y divide-border">
          {(tokens ?? []).map((tok) => (
            <div key={tok.id} className="py-2.5 flex items-center justify-between gap-3 text-sm">
              <div className="flex items-center gap-2 min-w-0">
                <code className="text-xs text-muted-foreground">{tok.tokenPrefix}…</code>
                <span className="text-foreground truncate">{tok.label}</span>
                {tok.status === 'REVOKED' && (
                  <Badge tone="neutral" size="sm">
                    {t('research.revoked', 'revoked')}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                <span>
                  {tok.lastUsedAt
                    ? `${t('research.lastUsed', 'last used')} ${new Date(tok.lastUsedAt).toLocaleDateString()}`
                    : t('research.neverUsed', 'never used')}
                </span>
                {tok.status === 'ACTIVE' && (
                  <button
                    onClick={() => setRevokeTarget(tok)}
                    className="text-danger hover:underline"
                  >
                    {t('research.revoke', 'Revoke')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}
        title={t('research.revokeTitle', { defaultValue: 'Revoke ingest token?' })}
        description={t('research.revokeDesc', {
          defaultValue:
            'Any integration pushing leads with this token will immediately lose access. This cannot be undone — you would need to mint a new token and reconfigure the integration.',
        })}
        confirmLabel={t('research.revoke', { defaultValue: 'Revoke' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={revokeToken.isPending}
        onConfirm={() => revokeTarget && revokeToken.mutate(revokeTarget.id)}
      />
    </Card>
  );
}
