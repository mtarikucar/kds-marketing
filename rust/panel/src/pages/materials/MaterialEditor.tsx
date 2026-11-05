import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as m from '@/api/materials';
import { getPerson, searchPeople } from '@/api/inbox';
import { ConfirmDialog } from '@/components/ui';
import {
  MaterialBadges,
  MaterialsError,
  MaterialsReadStatus,
  MediaThumb,
  TagsFields,
  cardClass,
  fieldClass,
  formatInstant,
  materialLabel,
  primaryClass,
  tapClass,
  useDecider,
  useMaterialsKey,
  useMaterialsMutation,
} from './MaterialsShared';
import { UsedInList } from './MaterialsUsedIn';

/**
 * Materyal: one material, its tags and quality (an agent's suggestion shown as such until a person
 * saves them), the people it shows, and the consent decisions only an owner or manager takes in
 * person (permission, "genel kullanılabilir", another olay, deletion), with where it was used.
 */
export function MaterialEditor({
  id,
  onBack,
  onOpenOlay,
  onOpenSlot,
}: {
  id: string;
  onBack: () => void;
  onOpenOlay: (id: string) => void;
  onOpenSlot: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const key = useMaterialsKey();
  const decider = useDecider();
  const detail = useQuery({ queryKey: [...key, 'material', id], queryFn: () => m.materialGet(id) });
  const olays = useQuery({ queryKey: [...key, 'olays'], queryFn: () => m.olaysList() });
  const material = detail.data?.material;
  const olay =
    material?.binding.kind === 'olay'
      ? olays.data?.find((o) => o.olay.id === (material.binding as { olay_id: string }).olay_id)?.olay
      : undefined;
  return (
    <div className="space-y-4" data-testid="material-editor">
      <button type="button" className={tapClass} onClick={onBack}>
        {t('materials.back')}
      </button>
      <MaterialsReadStatus query={detail} />
      {material && (
        <>
          <div className={`${cardClass} grid grid-cols-1 gap-4 sm:grid-cols-[10rem_minmax(0,1fr)]`}>
            <MediaThumb mime={material.mime} alt={materialLabel(t, material)} />
            <div className="min-w-0 space-y-2">
              <h3 className="break-words text-lg font-semibold">{materialLabel(t, material)}</h3>
              <MaterialBadges material={material} />
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">{t('materials.editor.origin')}</dt>
                <dd>
                  {material.origin.kind === 'real'
                    ? t('materials.editor.real')
                    : t('materials.editor.aiBy', { generator: material.origin.generator })}
                </dd>
                <dt className="text-muted-foreground">{t('materials.editor.binding')}</dt>
                <dd className="break-words">
                  {material.binding.kind === 'genel' ? (
                    t('materials.genel')
                  ) : olay ? (
                    <button type="button" className="underline" onClick={() => onOpenOlay(olay.id)}>
                      {olay.title}
                    </button>
                  ) : (
                    t('materials.editor.unknownOlay')
                  )}
                </dd>
                {material.captured_at && (
                  <>
                    <dt className="text-muted-foreground">{t('materials.editor.captured')}</dt>
                    <dd>{formatInstant(material.captured_at, i18n.language)}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">{t('materials.editor.added')}</dt>
                <dd>{formatInstant(material.created_at, i18n.language)}</dd>
              </dl>
            </div>
          </div>
          {material.erased_at ? (
            <p role="status" className="rounded-md bg-surface-muted p-3 text-sm">
              {t('materials.editor.erasedHelp')}
            </p>
          ) : (
            <>
              <TagsSection key={`tags-${material.revision}`} material={material} />
              <PeopleSection key={`people-${material.revision}`} material={material} />
              <PermissionSection key={`share-${material.revision}`} material={material} decider={decider} />
              {decider && material.origin.kind === 'real' && <FreeSection material={material} />}
              {decider && (
                <BindSection
                  key={`bind-${material.revision}`}
                  material={material}
                  olays={olays.data?.map((o) => o.olay) ?? []}
                />
              )}
              {decider && <DeleteSection material={material} used={detail.data!.used_in.length > 0} />}
            </>
          )}
          <section className={cardClass} aria-labelledby={`used-${id}`}>
            <h4 id={`used-${id}`} className="font-semibold">
              {t('materials.usedIn.title')}
            </h4>
            <UsedInList uses={detail.data!.used_in} onOpenSlot={onOpenSlot} />
          </section>
        </>
      )}
    </div>
  );
}

function TagsSection({ material }: { material: m.Material }) {
  const { t } = useTranslation();
  const [tags, setTags] = useState<m.Tags>(material.tags);
  const suggested = !material.tags_reviewed_by;
  const save = useMaterialsMutation(() =>
    m.materialTag(material.id, material.revision, {
      product_groups: tags.product_groups,
      doors: tags.doors,
      content_types: tags.content_types,
      quality: tags.quality,
      depicts: tags.depicts,
    }),
  );
  return (
    <form
      aria-label={t('materials.editor.tags')}
      className={cardClass}
      onSubmit={(e) => {
        e.preventDefault();
        if (!save.isPending) save.mutate(undefined);
      }}
    >
      <h4 className="font-semibold">{t('materials.editor.tags')}</h4>
      {suggested && (
        <p className="rounded-md bg-info-subtle p-3 text-sm">{t('materials.editor.suggestedHelp')}</p>
      )}
      <TagsFields value={tags} onChange={setTags} suggested={suggested} />
      <button className={primaryClass} disabled={save.isPending}>
        {suggested ? t('materials.editor.confirmTags') : t('materials.editor.saveTags')}
      </button>
      <MaterialsError error={save.error} />
    </form>
  );
}

/** One person the material shows, by name when the inbox lets this session read it. */
function PersonName({ id }: { id: string }) {
  const { t } = useTranslation();
  const person = useQuery({
    queryKey: ['inbox', 'person', id],
    queryFn: () => getPerson(id),
    retry: false,
  });
  const name = person.data?.person.display_name;
  return <span className="break-words">{name || t('materials.people.unnamed')}</span>;
}

/** The inbox persons it shows (KVKK: erasing one of them erases this material). */
function PeopleSection({ material }: { material: m.Material }) {
  const { t } = useTranslation();
  const [people, setPeople] = useState<string[]>(material.people);
  const [q, setQ] = useState('');
  const found = useQuery({
    queryKey: ['inbox', 'people', 'search', q],
    queryFn: () => searchPeople(q, 5),
    enabled: q.trim().length >= 2,
    retry: false,
  });
  const save = useMaterialsMutation(() => m.materialTag(material.id, material.revision, { people }));
  const changed = people.join() !== material.people.join();
  return (
    <section className={cardClass} aria-labelledby={`people-${material.id}`}>
      <h4 id={`people-${material.id}`} className="font-semibold">
        {t('materials.people.title')}
      </h4>
      <p className="text-sm text-muted-foreground">{t('materials.people.help')}</p>
      {people.length === 0 && <p className="text-sm">{t('materials.people.none')}</p>}
      <ul className="space-y-2">
        {people.map((p) => (
          <li key={p} className="flex items-center justify-between gap-2 text-sm">
            <PersonName id={p} />
            <button
              type="button"
              className={tapClass}
              onClick={() => setPeople((list) => list.filter((x) => x !== p))}
            >
              {t('materials.people.remove')}
            </button>
          </li>
        ))}
      </ul>
      <label className="flex flex-col gap-1 text-sm">
        <span>{t('materials.people.search')}</span>
        <input className={fieldClass} value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {found.data && (
        <ul className="space-y-2">
          {found.data
            .filter((p) => !people.includes(p.id))
            .map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className={`${tapClass} w-full justify-start`}
                  onClick={() => {
                    setPeople((list) => [...list, p.id]);
                    setQ('');
                  }}
                >
                  {t('materials.people.add', { name: p.display_name || p.company || p.id })}
                </button>
              </li>
            ))}
        </ul>
      )}
      <MaterialsReadStatus query={found} />
      {changed && (
        <button
          type="button"
          className={primaryClass}
          disabled={save.isPending}
          onClick={() => {
            if (!save.isPending) save.mutate(undefined);
          }}
        >
          {t('materials.people.save')}
        </button>
      )}
      <MaterialsError error={save.error} />
    </section>
  );
}

function PermissionSection({ material, decider }: { material: m.Material; decider: boolean }) {
  const { t, i18n } = useTranslation();
  const [permission, setPermission] = useState<m.SharePermission | ''>(
    material.share?.permission ?? '',
  );
  const save = useMaterialsMutation(() =>
    m.materialPermission(material.id, material.revision, permission as m.SharePermission),
  );
  const share = material.share;
  return (
    <form
      aria-label={t('materials.editor.permission')}
      className={cardClass}
      onSubmit={(e) => {
        e.preventDefault();
        if (decider && permission && !save.isPending) save.mutate(undefined);
      }}
    >
      <h4 className="font-semibold">{t('materials.editor.permission')}</h4>
      <p className="text-sm">
        {share
          ? t(share.by ? 'materials.editor.permissionByPerson' : 'materials.editor.permissionByAgent', {
              permission: t(`materials.share.${share.permission}`),
              at: formatInstant(share.at, i18n.language),
            })
          : t('materials.noPermission')}
      </p>
      {decider ? (
        <>
          <fieldset className="space-y-2">
            <legend className="sr-only">{t('materials.editor.permission')}</legend>
            {m.SHARE_PERMISSIONS.map((p) => (
              <label
                key={p}
                className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-md border p-3 ${
                  permission === p ? 'border-primary bg-primary/5' : 'border-border'
                }`}
              >
                <input
                  type="radio"
                  name={`permission-${material.id}`}
                  checked={permission === p}
                  onChange={() => setPermission(p)}
                />
                {t(`materials.share.${p}`)}
              </label>
            ))}
          </fieldset>
          <button
            className={primaryClass}
            disabled={!permission || save.isPending || (permission === share?.permission && !!share?.by)}
          >
            {t('materials.editor.savePermission')}
          </button>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t('materials.editor.permissionManagerOnly')}</p>
      )}
      <MaterialsError error={save.error} />
    </form>
  );
}

function FreeSection({ material }: { material: m.Material }) {
  const { t, i18n } = useTranslation();
  const free = useMaterialsMutation((value: boolean) =>
    m.materialFree(material.id, material.revision, value),
  );
  const genel = material.binding.kind === 'genel';
  return (
    <section className={cardClass}>
      <h4 className="font-semibold">{t('materials.editor.free')}</h4>
      <p className="text-sm text-muted-foreground">{t('materials.editor.freeHelp')}</p>
      {material.freed ? (
        <>
          <p className="text-sm">
            {t('materials.editor.freedAt', { at: formatInstant(material.freed.at, i18n.language) })}
          </p>
          {genel ? (
            <p className="text-sm text-muted-foreground">{t('materials.editor.genelStaysFreed')}</p>
          ) : (
            <button
              type="button"
              className={tapClass}
              disabled={free.isPending}
              onClick={() => {
                if (!free.isPending) free.mutate(false);
              }}
            >
              {t('materials.editor.unfree')}
            </button>
          )}
        </>
      ) : (
        <button
          type="button"
          className={primaryClass}
          disabled={free.isPending}
          onClick={() => {
            if (!free.isPending) free.mutate(true);
          }}
        >
          {t('materials.editor.makeFree')}
        </button>
      )}
      <MaterialsError error={free.error} />
    </section>
  );
}

function BindSection({ material, olays }: { material: m.Material; olays: m.Olay[] }) {
  const { t } = useTranslation();
  const current = material.binding.kind === 'olay' ? material.binding.olay_id : 'genel';
  const [target, setTarget] = useState(current);
  const bind = useMaterialsMutation(() =>
    m.materialBind(
      material.id,
      material.revision,
      target === 'genel' ? { kind: 'genel' } : { kind: 'olay', olay_id: target },
    ),
  );
  return (
    <form
      aria-label={t('materials.editor.bind')}
      className={cardClass}
      onSubmit={(e) => {
        e.preventDefault();
        if (target !== current && !bind.isPending) bind.mutate(undefined);
      }}
    >
      <h4 className="font-semibold">{t('materials.editor.bind')}</h4>
      <p className="text-sm text-muted-foreground">{t('materials.editor.bindHelp')}</p>
      <label className="flex flex-col gap-1 text-sm">
        <span>{t('materials.editor.bindTo')}</span>
        <select className={fieldClass} value={target} onChange={(e) => setTarget(e.target.value)}>
          {olays.map((o) => (
            <option key={o.id} value={o.id}>
              {o.title}
            </option>
          ))}
          <option value="genel">{t('materials.genel')}</option>
        </select>
      </label>
      <button className={primaryClass} disabled={target === current || bind.isPending}>
        {t('materials.editor.move')}
      </button>
      <MaterialsError error={bind.error} />
    </form>
  );
}

function DeleteSection({ material, used }: { material: m.Material; used: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const remove = useMaterialsMutation(
    () => m.materialDelete(material.id, material.revision),
    () => setOpen(false),
  );
  return (
    <section className={cardClass}>
      <h4 className="font-semibold">{t('materials.editor.delete')}</h4>
      <p className="text-sm text-muted-foreground">{t('materials.editor.deleteHelp')}</p>
      <button type="button" className={`${tapClass} border-danger/30 text-danger hover:bg-danger-subtle`} onClick={() => setOpen(true)}>
        {t('materials.editor.delete')}
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => !remove.isPending && setOpen(next)}
        title={t('materials.editor.deleteTitle')}
        description={`${t('materials.editor.deleteKvkk')}${used ? ` ${t('materials.editor.deleteUsed')}` : ''}`}
        confirmLabel={t('materials.editor.deleteConfirm')}
        cancelLabel={t('materials.editor.deleteCancel')}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => {
          if (!remove.isPending) remove.mutate(undefined);
        }}
      />
      <MaterialsError error={remove.error} />
    </section>
  );
}
