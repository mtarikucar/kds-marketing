import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as api from '@/api/studio';
import { listCapabilities } from '@/api/capabilities';
import type { CapabilityOut } from '@/api/types';
import {
  Region,
  Field,
  Reason,
  StudioError,
  StudioReadStatus,
  inputClass,
  buttonClass,
  useStudioKey,
  useStudioMutation,
} from './StudioShared';
import type { LaneKind } from '@/api/types';
import { kindLabel } from '@/lib/capabilities';
import { failureText } from '@/lib/delivery';
import { formatMoney } from '@/lib/format';
import { TiktokPostCounters, TiktokPostStatus, TiktokPostingScreen } from './StudioTiktok';
import { Link } from 'react-router-dom';
import type { TFunction } from 'i18next';
import * as lib from '@/api/materials';
import { MaterialHold } from './materials/MaterialHold';
import { materialsHref } from './materials/StudioMaterials';
import { MaterialsError, MaterialsReadStatus, findingText } from './materials/MaterialsShared';

/** A blocker of the slot: the material check's hold with its findings, else its reason. */
function Blocker({
  slot,
  blocker,
  shootCount,
}: {
  slot: api.Slot;
  blocker: api.Overview['today']['blockers'][number];
  shootCount: number;
}) {
  if (blocker.reason === 'material_check_hold') {
    return <MaterialHold slot={slot} details={blocker.details} shootCount={shootCount} />;
  }
  return <Reason reason={blocker.reason} />;
}

/** A subject as the owner reads it: an olay, last year's season, or nothing specific. */
function subjectLabel(
  t: TFunction,
  subject: lib.Subject,
  olays: lib.OlayListItem[] | undefined,
): string {
  if (subject.kind === 'generic') return t('materials.slot.subjectGeneric');
  const title = olays?.find((o) => o.olay.id === subject.olay_id)?.olay.title ?? '—';
  return subject.kind === 'olay'
    ? t('materials.slot.subjectOlay', { title })
    : t('materials.slot.subjectArchive', { title });
}

/** The subject in force: the one chosen, else that of the piece's own media, else the best. */
function pickedSubject(
  candidates: lib.SlotCandidate[],
  pieceFiles: string[],
  chosen: string | null,
): string | null {
  if (chosen) return chosen;
  const own = candidates.find((c) => pieceFiles.includes(c.file_id));
  const first = own ?? candidates[0];
  return first ? JSON.stringify(first.subject) : null;
}

/** The materials in force: those chosen, else the piece's own media under the subject. */
function pickedMaterials(
  candidates: lib.SlotCandidate[],
  pieceFiles: string[],
  subject: string | null,
  chosen: string[] | null,
): string[] {
  if (chosen) return chosen;
  return candidates
    .filter((c) => JSON.stringify(c.subject) === subject && pieceFiles.includes(c.file_id))
    .map((c) => c.material_id);
}

/**
 * What the piece shows (spec D2, D7): its subject and the library materials it may show at the
 * slot's time (`studio.slot_materials`), each as an anchor or a supporting visual. A piece names
 * one subject and shows at least one anchor; the server checks both again.
 */
function MaterialPicker({
  id,
  pieceFiles,
  subject,
  onSubject,
  chosen,
  onChosen,
}: {
  id: string;
  pieceFiles: string[];
  subject: string | null;
  onSubject: (subject: string) => void;
  chosen: string[] | null;
  onChosen: (ids: string[]) => void;
}) {
  const { t } = useTranslation();
  const key = useStudioKey();
  const options = useQuery({
    queryKey: [...key, 'materials', 'slot', id],
    queryFn: () => lib.slotMaterials(id),
  });
  const materials = useQuery({
    queryKey: [...key, 'materials', 'list', 'live'],
    queryFn: () => lib.materialsList(),
  });
  const olays = useQuery({ queryKey: [...key, 'materials', 'olays'], queryFn: () => lib.olaysList() });
  const candidates = options.data?.candidates ?? [];
  const subjects: string[] = [];
  for (const c of candidates) {
    const k = JSON.stringify(c.subject);
    if (!subjects.includes(k)) subjects.push(k);
  }
  const current = pickedSubject(candidates, pieceFiles, subject);
  const shown = candidates.filter((c) => JSON.stringify(c.subject) === current);
  const picked = pickedMaterials(candidates, pieceFiles, current, chosen);
  const title = (materialId: string) => {
    const x = materials.data?.find((y) => y.id === materialId);
    if (x?.title.trim()) return x.title;
    return x?.mime.startsWith('video/') ? t('materials.untitledVideo') : t('materials.untitledPhoto');
  };
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t('materials.slot.title')}</legend>
      <MaterialsReadStatus query={options} />
      {options.data && candidates.length === 0 && (
        <p className="text-sm">
          {t('materials.slot.none')}{' '}
          <Link className="underline" to={materialsHref('upload')}>
            {t('materials.slot.upload')}
          </Link>
        </p>
      )}
      {subjects.length > 0 && (
        <label className="flex flex-col gap-1 text-sm">
          <span>{t('materials.slot.subject')}</span>
          <select
            className={inputClass}
            value={current ?? ''}
            onChange={(e) => {
              onSubject(e.target.value);
              onChosen([]);
            }}
          >
            {subjects.map((k) => (
              <option key={k} value={k}>
                {subjectLabel(t, JSON.parse(k) as lib.Subject, olays.data)}
              </option>
            ))}
          </select>
        </label>
      )}
      <ul className="space-y-1">
        {shown.map((c) => (
          <li key={c.material_id}>
            <label className="flex min-h-11 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={picked.includes(c.material_id)}
                onChange={() =>
                  onChosen(
                    picked.includes(c.material_id)
                      ? picked.filter((x) => x !== c.material_id)
                      : [...picked, c.material_id],
                  )
                }
              />
              <span className="min-w-0 break-words">{title(c.material_id)}</span>
              <span className="text-xs text-muted-foreground">
                {t(`materials.role.${c.role}`)}
                {c.matches_need ? ` · ${t('materials.slot.matchesNeed')}` : ''}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {(options.data?.refused.length ?? 0) > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer">
            {t('materials.slot.refused', { count: options.data!.refused.length })}
          </summary>
          <ul className="mt-1 space-y-1">
            {options.data!.refused.map((r) => (
              <li key={r.material_id}>
                {title(r.material_id)}: {findingText(t, r.code)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </fieldset>
  );
}

/** Why the latest attempt to publish this slot failed, in the owner's words, when it did. */
function PublishFailure({ attempts }: { attempts: api.PublishAttempt[] }) {
  const { t } = useTranslation();
  const last = attempts[attempts.length - 1];
  if (!last?.failure_reason || !['failed', 'unknown', 'refused'].includes(last.state)) return null;
  const key = last.state === 'unknown' ? 'studio.publishUncertain' : 'studio.publishFailed';
  return (
    <p className="text-xs text-danger" role="status">
      {t(key, { reason: failureText(t, last.failure_reason) })}
    </p>
  );
}

/** The published post's page, once the latest attempt succeeded and the provider named one. */
function PostLink({ attempts }: { attempts: api.PublishAttempt[] }) {
  const { t } = useTranslation();
  const last = attempts[attempts.length - 1];
  const evidence = typeof last?.outcome?.evidence === 'object' ? last.outcome.evidence : null;
  if (last?.state !== 'succeeded' || !evidence?.url) return null;
  return (
    <a className="text-xs underline" href={evidence.url} target="_blank" rel="noreferrer noopener">
      {t('studio.postLink')}
    </a>
  );
}

/** The last path segment of a hosted media URL, which is what the owner recognises it by. */
function fileName(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : parsed.host;
  } catch {
    return url;
  }
}

/**
 * One media item of a drafted piece: a thumbnail for a hosted image, the file name for any other
 * hosted file. A stored upload is only an id here (no endpoint returns its name or bytes), so it
 * shows as an uploaded file.
 */
function MediaItem({ media, index }: { media: api.Media; index: number }) {
  const { t } = useTranslation();
  if (media.kind === 'hosted_url' && media.mime.startsWith('image/')) {
    return (
      <img
        src={media.url}
        alt={t('studio.mediaImage', { n: index, name: fileName(media.url) })}
        referrerPolicy="no-referrer"
        loading="lazy"
        className="h-20 w-20 rounded-md border border-border object-cover"
      />
    );
  }
  return (
    <span className="inline-flex max-w-full items-center break-all rounded-md border border-border px-2 py-1 text-xs">
      {media.kind === 'hosted_url' ? fileName(media.url) : t('studio.uploadedFile')}
    </span>
  );
}

/**
 * What approving this slot would publish: where and when, the drafted text and its media. It
 * reads the same cached slot detail the editor does.
 */
function PiecePreview({
  slot,
  arms,
  accounts,
}: {
  slot: api.Slot;
  arms: api.Arm[];
  accounts: CapabilityOut[] | undefined;
}) {
  const { t, i18n } = useTranslation();
  const key = useStudioKey();
  const detail = useQuery({
    queryKey: [...key, 'slot', slot.id],
    queryFn: () => api.slotGet(slot.id),
  });
  const channel = arms.find((a) => a.id === slot.chain.arm_id)?.key.channel;
  const account = accounts?.find((c) => c.capability.id === slot.capability_id)?.capability;
  const target = account
    ? `${account.name} · ${kindLabel(t, account.kind_key)}`
    : channel
      ? kindLabel(t, channel)
      : '—';
  const when = api.instant(slot.scheduled_at);
  const piece = detail.data?.piece;
  return (
    <div
      role="group"
      aria-label={t('studio.preview')}
      className="space-y-2 rounded-md border border-border bg-surface-muted p-3 text-sm"
    >
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t('studio.publishTo')}</dt>
        <dd className="break-words">{target}</dd>
        <dt className="text-muted-foreground">{t('studio.scheduledFor')}</dt>
        <dd>
          <time dateTime={when.toISOString()}>
            {when.toLocaleString(i18n.language, {
              timeZone: 'Europe/Istanbul',
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        </dd>
      </dl>
      {detail.data &&
        (piece?.text.trim() ? (
          <p className="whitespace-pre-wrap break-words">{piece.text}</p>
        ) : (
          !piece?.media.length && <p className="text-muted-foreground">{t('studio.noDraft')}</p>
        ))}
      {piece && piece.media.length > 0 && (
        <ul aria-label={t('studio.media')} className="flex flex-wrap gap-2">
          {piece.media.map((m, i) => (
            <li key={i}>
              <MediaItem media={m} index={i + 1} />
            </li>
          ))}
        </ul>
      )}
      <StudioReadStatus query={detail} />
    </div>
  );
}

/** Cancels the slot at `revision`, with the reason the ledger keeps. */
function CancelForm({ id, revision }: { id: string; revision: number }) {
  const { t } = useTranslation();
  const cancel = useStudioMutation((form: FormData) =>
    api.slotCancel(id, revision, String(form.get('reason'))),
  );
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!cancel.isPending) cancel.mutate(new FormData(e.currentTarget));
      }}
    >
      <Field label="reason">
        <input className={inputClass} name="reason" required maxLength={2000} />
      </Field>
      <button className={buttonClass} disabled={cancel.isPending}>
        {t('studio.cancel')}
      </button>
      <StudioError error={cancel.error} />
    </form>
  );
}

function SlotEditor({
  id,
  close,
  tiktok = false,
}: {
  id: string;
  close: () => void;
  /** A TikTok slot: once published, its post's counters show. */
  tiktok?: boolean;
}) {
  const { t } = useTranslation();
  const key = useStudioKey();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // Whatever opened the editor gets focus back when it is closed.
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    if (!opener.current) opener.current = document.activeElement;
    heading.current?.focus();
  }, []);
  const done = () => {
    const back = opener.current;
    close();
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  };
  const detail = useQuery({ queryKey: [...key, 'slot', id], queryFn: () => api.slotGet(id) });
  const pieceFiles = (detail.data?.piece?.media ?? []).flatMap((x) => (x.kind === 'file' ? [x.id] : []));
  const [subject, setSubject] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [unpicked, setUnpicked] = useState(false);
  const client = useQueryClient();
  const submit = useStudioMutation(
    ({ form, about, files }: { form: FormData; about: lib.Subject; files: string[] }) =>
      api.pieceSubmit(id, {
        expected_revision: detail.data!.slot.revision,
        request_key: crypto.randomUUID(),
        text: String(form.get('text')),
        media: files.map((f) => ({ kind: 'file' as const, id: f })),
        adaptations: detail.data!.piece?.adaptations ?? {},
        subject: about,
      }),
    () => {
      setSubject(null);
      setChosen(null);
    },
  );
  const data = detail.data;
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      id={`slot-editor-${id}`}
      className="space-y-5 rounded-lg border border-border bg-surface p-4 sm:p-5"
      data-testid="slot-detail"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <h3 ref={heading} id={headingId} tabIndex={-1} className="font-medium focus:outline-none">
          {data?.hypothesis.title ?? t('studio.detail')}
        </h3>
        <button className={buttonClass} onClick={done}>
          {t('studio.close')}
        </button>
      </div>
      <StudioReadStatus query={detail} />
      {data && (
        <>
          <p className="text-sm">
            {t('studio.brandRules')}: {data.brand_rules.identity.voice}
          </p>
          <ul className="text-xs">
            {data.brand_rules.prohibitions.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="text-xs">
            {t(`studio.${data.slot.state}`)} · {t('studio.evidence')}: {data.measurements.length}
          </p>
          <PublishFailure attempts={data.attempts} />
          <PostLink attempts={data.attempts} />
          {tiktok && ['published', 'measured'].includes(data.slot.state) && (
            <TiktokPostCounters slotId={id} />
          )}
          {/* A slot with an attempt is never sent again: new content would be a revision no
              run sends, so cancelling is its way out. */}
          {['planned', 'ready'].includes(data.slot.state) && !data.attempts.length && (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (submit.isPending) return;
                const options = client.getQueryData<lib.SlotMaterials>([
                  ...key,
                  'materials',
                  'slot',
                  id,
                ]);
                const candidates = options?.candidates ?? [];
                const about = pickedSubject(candidates, pieceFiles, subject);
                const ids = pickedMaterials(candidates, pieceFiles, about, chosen);
                const files = candidates
                  .filter((c) => JSON.stringify(c.subject) === about && ids.includes(c.material_id))
                  .map((c) => c.file_id);
                setUnpicked(!about || files.length === 0);
                if (!about || files.length === 0) return;
                submit.mutate({
                  form: new FormData(e.currentTarget),
                  about: JSON.parse(about) as lib.Subject,
                  files,
                });
              }}
            >
              <Field label="text">
                <textarea
                  key={`${id}-${data.slot.revision}`}
                  className={inputClass}
                  name="text"
                  rows={5}
                  defaultValue={data.piece?.text ?? ''}
                />
              </Field>
              <MaterialPicker
                id={id}
                pieceFiles={pieceFiles}
                subject={subject}
                onSubject={setSubject}
                chosen={chosen}
                onChosen={setChosen}
              />
              {unpicked && (
                <p role="alert" className="text-sm text-danger">
                  {t('materials.slot.pick')}
                </p>
              )}
              <button className={`${buttonClass} w-full`} disabled={submit.isPending}>
                {t('studio.submit')}
              </button>
            </form>
          )}
          {['planned', 'ready'].includes(data.slot.state) && (
            <CancelForm id={id} revision={data.slot.revision} />
          )}
          {data.slot.state === 'retired' && <p>{t('studio.retirement')}</p>}
        </>
      )}
      <MaterialsError error={submit.error} />
    </div>
  );
}
export function StudioToday({
  data,
  selectedSlot,
  onSelect,
  manage,
  overdue,
}: {
  data?: api.Overview;
  selectedSlot: string | null;
  onSelect: (id: string | null) => void;
  manage: boolean;
  overdue: boolean;
}) {
  const { t, i18n } = useTranslation();
  const key = useStudioKey();
  const [lane, setLane] = useState<LaneKind>('organic');
  const awaiting = (id: string) =>
    data?.today.approvals.some((a) => 'slot' in a && a.slot === id) ?? false;
  // Names the account an approval publishes to (without it the preview names the channel), and
  // tells a TikTok slot, which a human posts from its own screen.
  const accounts = useQuery({
    queryKey: [...key, 'accounts'],
    queryFn: () => listCapabilities(),
    enabled: Boolean(data?.today.slots.length || data?.slots.length),
  });
  const tiktok = (s: api.Slot) =>
    Boolean(
      accounts.data?.some(
        (c) => c.capability.id === s.capability_id && c.capability.kind_key === 'tiktok',
      ) ||
        data?.today.blockers.some(
          (b) =>
            'slot' in b.target && b.target.slot === s.id && b.next_action === 'tiktok_posting_screen',
        ),
    );
  // A TikTok piece awaiting its human is its posting screen, not a plain Approve button.
  const screen = (s: api.Slot) => manage && awaiting(s.id) && tiktok(s);
  // A slot whose publication failed or is uncertain is never sent again (no publish retries):
  // cancelling it is its way out.
  const stopped = (id: string) =>
    data?.today.blockers.some(
      (b) =>
        'slot' in b.target &&
        b.target.slot === id &&
        (b.next_action === 'reconnect_capability' ||
          b.next_action === 'review_publication_duplicate_risk'),
    ) ?? false;
  const arms = data?.learned.arms.map((a) => a.arm) ?? [];
  const others =
    data?.slots.filter(
      (s) =>
        !data.today.slots.some((p) => p.slot.id === s.id) &&
        (s.state === 'retired' ||
          data.today.blockers.some((b) => 'slot' in b.target && b.target.slot === s.id)),
    ) ?? [];
  // A slot listed here gets its editor in place; one picked elsewhere (the plan) gets it below.
  const inline =
    selectedSlot !== null &&
    (data?.today.slots.some(({ slot }) => slot.id === selectedSlot) ||
      others.some((s) => s.id === selectedSlot));
  const slotOf = (id: string) =>
    data?.slots.find((s) => s.id === id) ?? data?.today.slots.find(({ slot }) => slot.id === id)?.slot;
  const editor = (id: string) => {
    const slot = slotOf(id);
    return (
      <SlotEditor
        key={id}
        id={id}
        close={() => onSelect(null)}
        tiktok={slot ? tiktok(slot) : false}
      />
    );
  };
  const editorToggle = (id: string) => ({
    'aria-expanded': selectedSlot === id,
    'aria-controls': selectedSlot === id ? `slot-editor-${id}` : undefined,
    onClick: () => onSelect(selectedSlot === id ? null : id),
  });
  const [required, setRequired] = useState<boolean>();
  const approve = useStudioMutation(
    ({ target, revision }: { target: api.Target; revision: number }) =>
      api.approve(target, revision),
  );
  const policy = useStudioMutation(() =>
    api.policySet(
      lane,
      required ?? data!.control.lanes[lane]?.requires_human_approval ?? false,
      data!.control.revision,
    ),
  );
  const brake = useStudioMutation(() =>
    api.brake(!data!.control.lanes[lane]?.brake_engaged, lane, data!.control.revision),
  );
  const refresh = useStudioMutation(() => api.pending());
  // What waits to be shot or uploaded (the çekim listesi), from the same pending answer.
  const shoots = data?.today.shoot_requests?.length ?? 0;
  return (
    <Region name="today">
      <div className="flex flex-wrap items-center gap-2">
        {overdue && (
          <p className="rounded bg-warning-subtle px-2 py-1 text-sm">{t('studio.agentWaiting')}</p>
        )}
        <button
          className={buttonClass}
          disabled={!data || refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          {t('studio.refresh')}
        </button>
      </div>
      {shoots > 0 && (
        <p className="rounded-md bg-warning-subtle px-3 py-2 text-sm" data-testid="today-shoots">
          {t('materials.hold.shoots', { count: shoots })}{' '}
          <Link className="underline" to={materialsHref('shoots')}>
            {t('materials.hold.openShoots')}
          </Link>
        </p>
      )}
      <ul className="space-y-3">
        {data?.today.slots.map(({ slot, overdue }) => (
          <li
            key={slot.id}
            className="space-y-2 border-b border-border pb-3"
            data-testid={`today-${slot.id}`}
          >
            <div className="flex flex-wrap justify-between gap-2">
              <button className={`${buttonClass} text-start`} {...editorToggle(slot.id)}>
                {data.hypotheses.find((h) => h.id === slot.chain.hypothesis_id)?.title ??
                  t('studio.detail')}
              </button>
              <span className="text-sm">{t(`studio.${slot.state}`)}</span>
            </div>
            {awaiting(slot.id) && !screen(slot) && (
              <PiecePreview slot={slot} arms={arms} accounts={accounts.data} />
            )}
            {screen(slot) && <TiktokPostingScreen key={slot.revision} slot={slot} />}
            {!awaiting(slot.id) && slot.state === 'ready' && tiktok(slot) && (
              <TiktokPostStatus slot={slot} />
            )}
            {overdue && slot.state === 'planned' && (
              <p className="text-xs">{t('studio.agentWaiting')}</p>
            )}
            {data.today.blockers
              .filter((b) => 'slot' in b.target && b.target.slot === slot.id)
              .map((b, i) => (
                <Blocker key={i} slot={slot} blocker={b} shootCount={shoots} />
              ))}
            {/* Its open editor offers the same cancellation. */}
            {stopped(slot.id) && selectedSlot !== slot.id && (
              <div className="space-y-2">
                <p className="text-sm">{t('studio.notResent')}</p>
                <CancelForm id={slot.id} revision={slot.revision} />
              </div>
            )}
            {manage && awaiting(slot.id) && !screen(slot) && (
              <button
                className={buttonClass}
                disabled={approve.isPending}
                onClick={() =>
                  approve.mutate({ target: { slot: slot.id }, revision: slot.revision })
                }
              >
                {t('studio.approve')}
              </button>
            )}
            {selectedSlot === slot.id && editor(slot.id)}
          </li>
        ))}
      </ul>
      {data && !data.today.slots.length && !others.length && !data.today.budget_moves.length && !data.today.paid_alerts.length && !shoots && (
        <p className="text-sm text-muted-foreground">{t('studio.emptyToday')}</p>
      )}
      {data &&
        others.map((s) => (
          <div key={s.id} className="space-y-2">
            <button className={buttonClass} {...editorToggle(s.id)}>
              {t(`studio.${s.state}`)}
            </button>
            {data.today.blockers
              .filter((b) => 'slot' in b.target && b.target.slot === s.id)
              .map((b, i) => (
                <Blocker key={i} slot={s} blocker={b} shootCount={shoots} />
              ))}
            {selectedSlot === s.id && editor(s.id)}
          </div>
        ))}
      {data?.today.budget_moves.map((m) => (
        <div key={m.id} className="space-y-2 border-b border-border pb-3">
          <p className="text-sm">
            {t('studio.dailyBudget')}: {formatMoney(m.daily_budget_minor, m.currency, i18n.language)} ·{' '}
            {t(`studio.budgetState.${m.state}`)}
          </p>
          {data.today.blockers
            .filter((b) => 'budget_move' in b.target && b.target.budget_move === m.id)
            .map((b, i) => (
              <Reason key={i} reason={b.reason} />
            ))}
          {manage &&
            data.today.approvals.some((a) => 'budget_move' in a && a.budget_move === m.id) && (
              <button
                className={buttonClass}
                disabled={approve.isPending}
                onClick={() =>
                  approve.mutate({ target: { budget_move: m.id }, revision: m.revision })
                }
              >
                {t('studio.approve')}
              </button>
            )}
        </div>
      ))}
      {data?.today.paid_alerts.map((a) => (
        <div key={a.binding_id}>
          <Reason reason={a.reason} />
          {a.residual_provider_exposure && <p className="text-sm">{t('studio.exposure')}</p>}
        </div>
      ))}
      {selectedSlot && !inline && editor(selectedSlot)}
      {manage && data && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">{t('studio.policy')}</summary>
          <form
            className="mt-3 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              policy.mutate();
            }}
          >
            <Field label="channel">
              <select
                className={inputClass}
                value={lane}
                onChange={(e) => {
                  const next = e.target.value as LaneKind;
                  setLane(next);
                  setRequired(data.control.lanes[next]?.requires_human_approval ?? false);
                }}
              >
                <option value="organic">{t('studio.organic')}</option>
                {data.lane_support.paid.visible && <option value="paid">{t('studio.paid')}</option>}
              </select>
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={required ?? data.control.lanes[lane]?.requires_human_approval ?? false}
                onChange={(e) => setRequired(e.target.checked)}
              />
              {t('studio.requiresApproval')}
            </label>
            <button className={buttonClass} disabled={policy.isPending}>
              {t('studio.savePolicy')}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={brake.isPending}
              onClick={() => brake.mutate()}
            >
              {t(
                data.control.lanes[lane]?.brake_engaged ? 'studio.laneRelease' : 'studio.laneBrake',
              )}
            </button>
          </form>
        </details>
      )}
      <StudioError error={approve.error || policy.error || brake.error || refresh.error} />
    </Region>
  );
}
