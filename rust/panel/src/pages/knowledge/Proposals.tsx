import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { acceptProposal, skipProposal, type CardOut, type ProposalOut } from '@/api/knowledge';
import { Button, cn, toast } from '@/components/ui';
import { useKnowledgeMutation } from './queries';
import { knowledgeError } from './words';

/**
 * The words of `next` that `before` does not have, marked: a longest common subsequence over
 * whitespace-separated words, so a `card_edit` shows what it adds to the card.
 */
export function markAdded(before: string, next: string): { text: string; added: boolean }[] {
  const a = before.split(/(\s+)/).filter((w) => w !== '');
  const b = next.split(/(\s+)/).filter((w) => w !== '');
  // Too long to compare word by word in a browser frame: shown as written.
  if (a.length * b.length > 4_000_000) return [{ text: next, added: false }];
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: { text: string; added: boolean }[] = [];
  const push = (text: string, added: boolean) => {
    const last = out.at(-1);
    // Spaces join the run they sit in, so one added phrase is one mark.
    if (last && (last.added === added || /^\s+$/.test(text))) last.text += text;
    else out.push({ text, added });
  };
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && a[i] === b[j]) {
      push(b[j], false);
      i++;
      j++;
    } else if (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1]) {
      i++;
    } else {
      push(b[j], !/^\s+$/.test(b[j]));
      j++;
    }
  }
  return out;
}

/** A refusal of "Ekle" or "Geç", by the proposal it is about. */
interface Refusal {
  id: string;
  message: string;
}

function ProposalBlock({
  proposal,
  cards,
  editable,
  refusal,
  onRefused,
}: {
  proposal: ProposalOut;
  cards: CardOut[];
  editable: boolean;
  refusal: string | null;
  onRefused: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const [whole, setWhole] = useState(false);
  // Told by the list, before the read again drops a proposal that is no longer pending.
  const refused = (err: unknown) => onRefused(knowledgeError(t, err));
  const accept = useKnowledgeMutation(
    () => acceptProposal(proposal.id),
    () => {
      toast.success(t('knowledge.proposals.accepted'));
    },
    refused,
  );
  const skip = useKnowledgeMutation(() => skipProposal(proposal.id), undefined, refused);
  const card = proposal.card_id ? cards.find((c) => c.id === proposal.card_id) : undefined;
  const heading =
    proposal.kind === 'card_new'
      ? t('knowledge.proposals.cardNew', { title: proposal.title ?? '' })
      : proposal.kind === 'card_edit'
        ? t('knowledge.proposals.cardEdit', { card: card?.title ?? proposal.title ?? t('knowledge.notes.aCard') })
        : proposal.kind === 'rule_add'
          ? t('knowledge.proposals.ruleAdd')
          : t('knowledge.proposals.goalAdd');
  const text: ReactNode =
    proposal.kind === 'card_edit' && card
      ? markAdded(card.body, proposal.body).map((part, i) =>
          part.added ? <mark key={i} className="rounded-sm bg-success-subtle px-0.5 text-foreground">{part.text}</mark> : <span key={i}>{part.text}</span>,
        )
      : proposal.body;
  const long = proposal.body.split('\n').length > 3 || proposal.body.length > 240;
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-3 sm:px-4">
      <h3 className="text-sm font-semibold [overflow-wrap:anywhere]">{heading}</h3>
      <p className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{t('knowledge.proposals.reason', { reason: proposal.reason })}</p>
      <p className={cn('whitespace-pre-line text-sm leading-relaxed [overflow-wrap:anywhere]', !whole && 'line-clamp-3')}>{text}</p>
      {long && (
        <button type="button" className="self-start text-caption font-medium text-primary underline-offset-4 hover:underline" aria-expanded={whole} onClick={() => setWhole((w) => !w)}>
          {whole ? t('knowledge.less') : t('knowledge.proposals.whole')}
        </button>
      )}
      {editable && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" loading={accept.isPending} disabled={skip.isPending} onClick={() => { onRefused(null); accept.mutate(undefined); }}>
            {t('knowledge.proposals.accept')}
          </Button>
          <Button size="sm" variant="outline" loading={skip.isPending} disabled={accept.isPending} onClick={() => { onRefused(null); skip.mutate(undefined); }}>
            {t('knowledge.proposals.skip')}
          </Button>
        </div>
      )}
      {refusal && <p role="alert" className="text-caption text-danger">{refusal}</p>}
    </li>
  );
}

/**
 * "Ajanın önerileri" (§4.11.5): what the agents learned and the owner adds or skips. A refusal
 * stays said under the proposal while it is listed, and above the list once the read no longer
 * lists it (superseded, expired or closed meanwhile).
 */
export function Proposals({ proposals, cards, editable }: { proposals: ProposalOut[]; cards: CardOut[]; editable: boolean }) {
  const { t } = useTranslation();
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const gone = refusal && !proposals.some((p) => p.id === refusal.id) ? refusal.message : null;
  return (
    <section id="oneriler" aria-labelledby="knowledge-proposals" className="flex scroll-mt-6 flex-col gap-2 rounded-xl border border-dashed border-primary/30 bg-primary/5 px-4 py-4 sm:px-5">
      <h2 id="knowledge-proposals" className="text-sm font-semibold">{t('knowledge.proposals.title')}</h2>
      {gone && <p role="alert" className="text-sm text-danger">{gone}</p>}
      {proposals.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('knowledge.proposals.none')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {proposals.map((p) => (
            <ProposalBlock
              key={p.id}
              proposal={p}
              cards={cards}
              editable={editable}
              refusal={refusal?.id === p.id ? refusal.message : null}
              onRefused={(message) => setRefusal(message === null ? null : { id: p.id, message })}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
