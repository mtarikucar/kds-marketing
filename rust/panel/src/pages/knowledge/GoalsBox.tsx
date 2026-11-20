import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { LIMITS, saveGoals, type GoalsOut } from '@/api/knowledge';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, toast } from '@/components/ui';
import { LinesEditor, fromLines, toLines } from './RulesBox';
import { isStale, useKnowledgeMutation } from './queries';
import { knowledgeError } from './words';

/** How many goals the box shows before "{n} hedef daha". */
const SHOWN = 3;

/**
 * "Düzenle" of Hedefler: the list, saved over the goals as they were when the dialog opened (the
 * page reads again on its own meanwhile); a stale save shows them as they now are.
 */
function GoalsDialog({ goals, open, onOpenChange }: { goals: GoalsOut; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const [base, setBase] = useState(goals.revision);
  const [reload, setReload] = useState(false);
  const [lines, setLines] = useState(() => toLines(goals.items));
  const save = useKnowledgeMutation(
    saveGoals,
    () => {
      toast.success(t('knowledge.saved'));
      onOpenChange(false);
    },
    (err) => {
      if (isStale(err)) setReload(true);
    },
  );
  const load = (from: GoalsOut) => {
    setBase(from.revision);
    setLines(toLines(from.items));
  };
  useEffect(() => {
    if (!open) return;
    load(goals);
    setReload(false);
    save.reset();
  }, [open]);
  // After a stale save, the goals as they now are once the read has them.
  useEffect(() => {
    if (!open || !reload || goals.revision === base) return;
    load(goals);
    setReload(false);
  }, [goals.revision, reload]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ expected_revision: base, items: fromLines(lines) });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-dvh max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('knowledge.goals.title')}</DialogTitle>
          <DialogDescription>{t('knowledge.goals.dialog.help')}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <LinesEditor
            lines={lines}
            onChange={setLines}
            max={LIMITS.goals}
            maxLength={LIMITS.goal}
            addLabel={t('knowledge.goals.dialog.add')}
            itemLabel={(n) => t('knowledge.goals.dialog.item', { n })}
            removeLabel={(n) => t('knowledge.goals.dialog.remove', { n })}
          />
          {save.error && <p role="alert" className="text-sm text-danger">{knowledgeError(t, save.error)}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('knowledge.cancel')}
            </Button>
            <Button type="submit" loading={save.isPending}>
              {t('knowledge.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Hedefler" (§4.11.3): the first three goals, then the rest folded. */
export function GoalsBox({ goals, editable }: { goals: GoalsOut; editable: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? goals.items : goals.items.slice(0, SHOWN);
  const rest = goals.items.length - SHOWN;
  return (
    <section id="hedefler" aria-labelledby="knowledge-goals" className="flex min-w-0 flex-[1_1_18rem] scroll-mt-6 flex-col gap-3 rounded-xl border border-border bg-surface px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id="knowledge-goals" className="flex-1 text-base font-semibold">{t('knowledge.goals.title')}</h2>
        {editable && (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)} aria-label={t('knowledge.goals.editLabel')}>
            {t('knowledge.edit')}
          </Button>
        )}
      </div>
      {goals.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('knowledge.goals.none')}</p>
      ) : (
        <ul className="flex list-disc flex-col gap-1.5 ps-5 text-sm leading-relaxed [overflow-wrap:anywhere]">
          {shown.map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      )}
      {rest > 0 && (
        <button type="button" className="self-start text-sm text-muted-foreground underline-offset-4 hover:underline" aria-expanded={expanded} onClick={() => setExpanded((x) => !x)}>
          {expanded ? t('knowledge.less') : t('knowledge.goals.more', { n: rest })}
        </button>
      )}
      {editable && <GoalsDialog goals={goals} open={open} onOpenChange={setOpen} />}
    </section>
  );
}
