import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as m from '@/api/materials';
import {
  MaterialTile,
  MaterialsError,
  OlayFields,
  OlayLine,
  ProposedBadge,
  cardClass,
  draftOf,
  emptyOlay,
  gridClass,
  olayDraftProblem,
  olayInput,
  primaryClass,
  tapClass,
  useDecider,
  useMaterialsKey,
  useMaterialsMutation,
  type OlayDraft,
} from './MaterialsShared';
import { ShootRow } from './MaterialsShoots';
import { UsedInList } from './MaterialsUsedIn';

/** The pseudo-olays of the list: genel materials, and those waiting for a person. */
export const GENEL = 'genel';
export const REVIEW = 'review';

/** An owner or manager confirms a proposed olay: from then on its materials may be used (D3). */
function ConfirmButton({ olay }: { olay: m.Olay }) {
  const { t } = useTranslation();
  const confirm = useMaterialsMutation(() => m.olayConfirm(olay.id, olay.revision));
  return (
    <div className="space-y-1">
      <button
        type="button"
        className={primaryClass}
        disabled={confirm.isPending}
        onClick={() => {
          if (!confirm.isPending) confirm.mutate(undefined);
        }}
      >
        {t('materials.olay.confirm')}
      </button>
      <MaterialsError error={confirm.error} />
    </div>
  );
}

/** Creates an olay, or changes one (at its revision). */
function OlayForm({
  olay,
  onDone,
}: {
  olay?: m.Olay;
  onDone: (olay: m.Olay) => void;
}) {
  const { t } = useTranslation();
  const key = useMaterialsKey();
  const [draft, setDraft] = useState<OlayDraft>(() => (olay ? draftOf(olay) : emptyOlay()));
  const [problem, setProblem] = useState<'title' | 'dates' | 'occasion' | null>(null);
  const requestKey = useRef<string | null>(null);
  const year = Number((draft.starts_on || m.istanbulDay(new Date())).slice(0, 4));
  const calendar = useQuery({
    queryKey: [...key, 'calendar', year],
    queryFn: () => m.calendarList(year),
    enabled: m.isSeasonal(draft.kind),
  });
  const save = useMaterialsMutation(
    () => {
      const input = olayInput(draft, olay?.client);
      if (olay) return m.olayUpdate(olay.id, olay.revision, input);
      requestKey.current ??= crypto.randomUUID();
      return m.olayCreate({ ...input, request_key: requestKey.current });
    },
    (saved) => onDone(saved),
  );
  return (
    <form
      className={cardClass}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (save.isPending) return;
        const p = olayDraftProblem(draft);
        setProblem(p);
        if (!p) save.mutate(undefined);
      }}
    >
      <h4 className="font-semibold">{olay ? t('materials.olay.edit') : t('materials.olay.new')}</h4>
      <OlayFields
        value={draft}
        onChange={(d) => {
          setDraft(d);
          requestKey.current = null;
        }}
        occasions={calendar.data?.entries ?? []}
      />
      {problem && (
        <p role="alert" className="text-sm text-danger">
          {t(`materials.upload.problem.${problem}`)}
        </p>
      )}
      <button className={primaryClass} disabled={save.isPending}>
        {olay ? t('materials.olay.save') : t('materials.olay.create')}
      </button>
      <MaterialsError error={save.error} />
    </form>
  );
}

function OlayRow({
  item,
  decider,
  onOpen,
}: {
  item: m.OlayListItem;
  decider: boolean;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { olay } = item;
  return (
    <li className="space-y-2 rounded-md border border-border p-3" data-testid={`olay-${olay.id}`}>
      <button
        type="button"
        className="flex min-h-11 w-full min-w-0 flex-col items-start gap-1 text-start"
        onClick={() => onOpen(olay.id)}
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{olay.title}</span>
          <ProposedBadge olay={olay} />
        </span>
        <OlayLine olay={olay} />
        <span className="text-sm">{t('materials.olay.count', { count: item.materials })}</span>
      </button>
      {olay.status === 'proposed' && decider && <ConfirmButton olay={olay} />}
    </li>
  );
}

/** Olaylar: every olay, newest first, with the library's two other shelves. */
function OlayList({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const key = useMaterialsKey();
  const decider = useDecider();
  const [creating, setCreating] = useState(false);
  const olays = useQuery({ queryKey: [...key, 'olays'], queryFn: () => m.olaysList() });
  const review = useQuery({
    queryKey: [...key, 'list', REVIEW],
    queryFn: () => m.materialsList({ state: 'needs_review' }),
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={primaryClass} onClick={() => setCreating((c) => !c)}>
          {t('materials.olay.new')}
        </button>
        {(review.data?.length ?? 0) > 0 && (
          <button type="button" className={tapClass} onClick={() => onOpen(REVIEW)}>
            {t('materials.review.open', { count: review.data!.length })}
          </button>
        )}
        <button type="button" className={tapClass} onClick={() => onOpen(GENEL)}>
          {t('materials.genelShelf')}
        </button>
      </div>
      {creating && (
        <OlayForm
          onDone={(o) => {
            setCreating(false);
            onOpen(o.id);
          }}
        />
      )}
      <MaterialsError error={olays.error} />
      {olays.data && olays.data.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('materials.olay.empty')}</p>
      )}
      <ul className="space-y-3" aria-label={t('materials.views.olays')}>
        {olays.data?.map((item) => (
          <OlayRow key={item.olay.id} item={item} decider={decider} onOpen={onOpen} />
        ))}
      </ul>
    </div>
  );
}

/** A shelf of materials that belong to no olay row: genel ones, or those waiting for a person. */
function Shelf({
  shelf,
  onBack,
  onOpenMaterial,
}: {
  shelf: typeof GENEL | typeof REVIEW;
  onBack: () => void;
  onOpenMaterial: (id: string) => void;
}) {
  const { t } = useTranslation();
  const key = useMaterialsKey();
  const list = useQuery({
    queryKey: [...key, 'list', shelf],
    queryFn: () => m.materialsList(shelf === REVIEW ? { state: 'needs_review' } : {}),
  });
  const shown =
    shelf === GENEL ? list.data?.filter((x) => x.binding.kind === 'genel') : list.data;
  return (
    <div className="space-y-4">
      <button type="button" className={tapClass} onClick={onBack}>
        {t('materials.back')}
      </button>
      <h3 className="text-lg font-semibold">
        {shelf === GENEL ? t('materials.genelShelf') : t('materials.review.title')}
      </h3>
      <p className="text-sm text-muted-foreground">
        {shelf === GENEL ? t('materials.genelHelp') : t('materials.review.help')}
      </p>
      <MaterialsError error={list.error} />
      {shown && shown.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('materials.noMaterials')}</p>
      )}
      <ul className={gridClass}>
        {shown?.map((x) => <MaterialTile key={x.id} material={x} onOpen={onOpenMaterial} />)}
      </ul>
    </div>
  );
}

/** One olay: what it is, its materials, its open çekim listesi items and where they were used. */
function OlayDetailView({
  id,
  onBack,
  onOpenMaterial,
  onOpenSlot,
  onUpload,
}: {
  id: string;
  onBack: () => void;
  onOpenMaterial: (id: string) => void;
  onOpenSlot: (id: string) => void;
  onUpload: (olayId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const key = useMaterialsKey();
  const decider = useDecider();
  const [editing, setEditing] = useState(false);
  const detail = useQuery({ queryKey: [...key, 'olay', id], queryFn: () => m.olayGet(id) });
  const data = detail.data;
  const uses = data?.materials.flatMap((x) => x.used_in) ?? [];
  // A piece that showed several of the olay's materials is listed once.
  const seen = new Set<string>();
  const usedIn = uses.filter((u) => {
    const k = `${u.piece_id}-${u.revision}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return (
    <div className="space-y-4" data-testid="olay-detail">
      <button type="button" className={tapClass} onClick={onBack}>
        {t('materials.back')}
      </button>
      <MaterialsError error={detail.error} />
      {data && (
        <>
          <section className={cardClass}>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold">{data.olay.title}</h3>
              <ProposedBadge olay={data.olay} />
            </div>
            <OlayLine olay={data.olay} />
            {data.olay.client?.organization && (
              <p className="text-sm">
                {t('materials.olay.organization')}: {data.olay.client.organization}
              </p>
            )}
            {data.olay.notes && <p className="whitespace-pre-wrap text-sm">{data.olay.notes}</p>}
            {data.olay.status === 'proposed' && (
              <p className="text-sm text-muted-foreground">{t('materials.olay.proposedHelp')}</p>
            )}
            <div className="flex flex-wrap gap-2">
              {data.olay.status === 'proposed' && decider && <ConfirmButton olay={data.olay} />}
              <button type="button" className={primaryClass} onClick={() => onUpload(data.olay.id)}>
                {t('materials.olay.upload')}
              </button>
              {(decider || data.olay.status === 'proposed') && (
                <button type="button" className={tapClass} onClick={() => setEditing((e) => !e)}>
                  {t('materials.olay.edit')}
                </button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('materials.olay.since', {
                at: new Date(data.olay.created_at).toLocaleDateString(i18n.language),
              })}
            </p>
          </section>
          {editing && (
            <OlayForm
              key={data.olay.revision}
              olay={data.olay}
              onDone={() => setEditing(false)}
            />
          )}
          <section className={cardClass} aria-labelledby={`olay-materials-${id}`}>
            <h4 id={`olay-materials-${id}`} className="font-semibold">
              {t('materials.olay.materials', { count: data.materials.length })}
            </h4>
            {data.materials.length === 0 && (
              <p className="text-sm text-muted-foreground">{t('materials.noMaterials')}</p>
            )}
            <ul className={gridClass}>
              {data.materials.map((x) => (
                <MaterialTile key={x.material.id} material={x.material} onOpen={onOpenMaterial} />
              ))}
            </ul>
          </section>
          {data.shoot_requests.length > 0 && (
            <section className={cardClass} aria-labelledby={`olay-shoots-${id}`}>
              <h4 id={`olay-shoots-${id}`} className="font-semibold">
                {t('materials.olay.shoots')}
              </h4>
              <ul className="space-y-2">
                {data.shoot_requests.map((r) => (
                  <ShootRow key={r.id} request={r} />
                ))}
              </ul>
            </section>
          )}
          <section className={cardClass} aria-labelledby={`olay-used-${id}`}>
            <h4 id={`olay-used-${id}`} className="font-semibold">
              {t('materials.usedIn.title')}
            </h4>
            <UsedInList uses={usedIn} onOpenSlot={onOpenSlot} />
          </section>
        </>
      )}
    </div>
  );
}

/** The Olaylar view: the list, a shelf, or one olay. */
export function MaterialsOlays({
  olayId,
  onOpenOlay,
  onOpenMaterial,
  onOpenSlot,
  onUpload,
}: {
  olayId?: string;
  onOpenOlay: (id: string | null) => void;
  onOpenMaterial: (id: string) => void;
  onOpenSlot: (id: string) => void;
  onUpload: (olayId: string) => void;
}) {
  if (olayId === GENEL || olayId === REVIEW) {
    return <Shelf shelf={olayId} onBack={() => onOpenOlay(null)} onOpenMaterial={onOpenMaterial} />;
  }
  if (olayId) {
    return (
      <OlayDetailView
        id={olayId}
        onBack={() => onOpenOlay(null)}
        onOpenMaterial={onOpenMaterial}
        onOpenSlot={onOpenSlot}
        onUpload={onUpload}
      />
    );
  }
  return <OlayList onOpen={onOpenOlay} />;
}
