import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { projectGet, projectUpdate } from '@/api/projects';
import { areaRedo, deliveryAccept, type AreaRow, type Stage, type StageState } from '@/api/content';
import { listCapabilities } from '@/api/capabilities';
import { Button, Callout, Dialog, DialogContent, DialogDescription, DialogTitle, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { formatNumber } from '@/lib/format';
import { fieldClass, findingText, materialLabel, MaterialsReadStatus, useMaterialsKey, useMaterialsMutation } from '../materials/MaterialsShared';
import { ProjectRequests } from '../projects/ProjectRequests';
import { ProjectMaterials } from '../projects/ProjectMaterials';
import { ProjectError } from '../projects/ProjectShared';
import { areaTime, currentPackage, MiniThumb, StateBadge, stepName } from './AreaShared';
import { PlatformFrame } from './PlatformFrame';
import { AreaHistory } from './AreaHistory';
import { blockedText, PostLink, publicationText, scheduleHref, StageNode } from './PipelineRow';
import { placeHref, useContentPlace } from './location';
import { useUploads } from './uploads';

const WINDOWS = { hours24: '24', hours72: '72', days7: '168' } as const;

/** A step's note, when it says more than its output: the same sentence is shown once. */
export function noteBeyondOutput(report: { note: string; output?: string }): string | null {
  const note = report.note.trim();
  if (!note || note === (report.output ?? '').trim()) return null;
  return note;
}

/** The step stages' fourteen steps and what follows them, each with what the agent reported. */
function Timeline({ row, files }: { row: AreaRow; files: boolean }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const current = row.pipeline.current_step;
  const publications = row.pipeline.stages.find((s) => s.key === 'yayin')?.publications ?? [];
  const account = (slot: string) => publications.find((p) => p.slot_id === slot)?.account_name ?? t('contentAreas.account');
  const stepState = (stage: Stage, n: number, reported: boolean): StageState =>
    stage.state === 'done' ? 'done' : n === current ? stage.state : reported ? 'done' : 'todo';
  return (
    <ol aria-label={t('contentAreas.stepsLabel')} className="space-y-4">
      {row.pipeline.stages.map((stage) => (
        <li key={stage.key} className="space-y-2">
          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <StageNode state={stage.state} small />
            {t(`content.stage.${stage.key}`)}
            <span className="sr-only">: {t(`content.stageState.${stage.state}`)}</span>
          </p>
          {stage.span && (
            <ol className="space-y-2 border-s-2 border-border ps-4">
              {Array.from({ length: stage.span[1] - stage.span[0] + 1 }, (_, i) => stage.span![0] + i).map((n) => {
                const report = stage.steps?.find((s) => s.step === n);
                const state = stepState(stage, n, !!report);
                return (
                  <li key={n} aria-current={n === current ? 'step' : undefined} className="space-y-0.5 text-sm">
                    <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className={state === 'todo' ? 'text-muted-foreground' : 'font-medium'}>
                        <span className="tabular-nums">{n}.</span> {stepName(t, n)}
                        <span className="sr-only">: {t(`content.stageState.${state}`)}</span>
                      </span>
                      {report && <time dateTime={report.at} className="font-mono text-xs text-muted-foreground">{areaTime(report.at, lang)}</time>}
                    </p>
                    {report?.output && <p className="break-words font-medium text-foreground">{report.output}</p>}
                    {report && noteBeyondOutput(report) && <p className="break-words text-xs text-muted-foreground">{noteBeyondOutput(report)}</p>}
                    {!!report?.material_ids?.length && (
                      <span className="flex flex-wrap gap-1 pt-1">
                        {report.material_ids.map((id) => <MiniThumb key={id} id={id} files={files} />)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {stage.key === 'onay' && !!stage.approvals?.length && (
            <ul className="space-y-1 border-s-2 border-border ps-4 text-sm">
              {stage.approvals.map((a) => (
                <li key={a.slot_id} className="break-words">
                  <span className="font-medium">{account(a.slot_id)}</span>{' · '}
                  {a.waiting
                    ? <Link className="text-warning underline" to={`/social?slot=${encodeURIComponent(a.slot_id)}`}>{t('content.out.awaitsApproval')}</Link>
                    : a.approved_at ? t('content.out.approved', { at: areaTime(a.approved_at, lang) })
                      : a.required ? t('content.out.approvalRequired') : t('content.out.noApproval')}
                </li>
              ))}
            </ul>
          )}
          {stage.key === 'onay' && !!row.pipeline.unscheduled?.length && (
            <ul className="space-y-1 border-s-2 border-border ps-4 text-sm">
              {row.pipeline.unscheduled.map((w) => (
                <li key={w.version_id} className="break-words">
                  <span className="font-medium">{t(`posts.format.${w.format}`)}</span>{' · '}
                  {w.blocked
                    ? <span className="text-danger">{blockedText(t, w)}</span>
                    : <span className="text-muted-foreground">{t('content.out.awaitsTimeOne')}</span>}{' '}
                  <Link className="text-primary underline" to={scheduleHref(w.version_id)}>{t(w.blocked ? 'content.bar.toPackages' : 'content.bar.giveTime')}</Link>
                </li>
              ))}
            </ul>
          )}
          {stage.key === 'yayin' && !!stage.publications?.length && (
            <ul className="space-y-1 border-s-2 border-border ps-4 text-sm">
              {stage.publications.map((p) => (
                <li key={p.slot_id} className="flex flex-wrap items-baseline gap-x-2 break-words">
                  <Link className="font-medium underline decoration-border underline-offset-4" to={`/social?slot=${encodeURIComponent(p.slot_id)}`}>{p.account_name ?? t('contentAreas.account')}</Link>
                  <span className={p.failed ? 'text-danger' : 'text-muted-foreground'}>
                    {publicationText(t, p, lang, true)}
                  </span>
                  <PostLink url={p.url} />
                </li>
              ))}
            </ul>
          )}
          {stage.key === 'sonuc' && !!stage.results?.length && (
            <ul className="space-y-2 border-s-2 border-border ps-4 text-sm">
              {stage.results.map((r) => {
                const p = publications.find((x) => x.version_id === r.version_id);
                return (
                  <li key={r.publication_id} className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      {p?.account_name ?? t('contentAreas.account')} · {t('content.out.window', { hours: WINDOWS[r.window] })} · {areaTime(r.measured_at, lang)}
                    </p>
                    <dl className="flex flex-wrap gap-x-4 gap-y-1">
                      {Object.entries(r.metrics).filter(([, v]) => v !== null).map(([k, v]) => (
                        <div key={k} className="flex flex-col leading-tight">
                          <dt className="order-2 text-micro text-muted-foreground">{t(`content.metric.${k}`, { defaultValue: k })}</dt>
                          <dd className="order-1 font-medium">{formatNumber(v as number, lang)}</dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                );
              })}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * An open content: its steps and what follows them (from the row's pipeline), the platform
 * versions of its current package one at a time in the platform's frame, and what a person may
 * do here: "Olmamış" with what should change, accept a delivery only its text check held, answer
 * the agent's capture requests, add or take out sources, archive it. Without a row (a content
 * not on the list, an archived one opened by its link) the steps are left out.
 */
export function AreaDetail({ id, row, manage, files }: { id: string; row?: AreaRow; manage: boolean; files: boolean }) {
  const { t } = useTranslation();
  const key = useMaterialsKey();
  const client = useQueryClient();
  const uploads = useUploads();
  const [place] = useContentPlace();
  const detailKey = [...key, 'areas', id];
  const detail = useQuery({ queryKey: detailKey, queryFn: () => projectGet(id), refetchInterval: 15_000 });
  const accounts = useQuery({ queryKey: [...key, 'social-accounts'], queryFn: () => listCapabilities({ group: 'social_account', status: 'verified' }) });
  const [selected, setSelected] = useState('');
  // The package the person was looking at when they opened the dialog (`null`: none yet);
  // `undefined`: the dialog is closed. The note is about that package, whatever arrives meanwhile.
  const [redoFor, setRedoFor] = useState<number | null>();
  const [note, setNote] = useState('');
  const [attach, setAttach] = useState(false);
  const redo = useMaterialsMutation(
    () => areaRedo(id, { package_revision: redoFor ?? null, note: note.trim() }),
    (result) => { client.setQueryData(detailKey, result); setRedoFor(undefined); setNote(''); },
  );
  const accept = useMaterialsMutation(
    (expected_revision: number) => deliveryAccept(id, { expected_revision }),
    (result) => client.setQueryData(detailKey, result),
  );
  // An agent reporting its steps moves the area's revision; archive what is there now.
  const archive = useMaterialsMutation(async (archived: boolean) =>
    projectUpdate(id, { expected_revision: (await projectGet(id)).project.revision, archived }));
  const project = detail.data?.project;
  const pkg = project && currentPackage(project);
  const versions = pkg?.versions ?? [];
  const version = versions.find((v) => v.id === selected) ?? versions[0];
  const materials = detail.data?.materials ?? [];
  const accountName = (capabilityId: string | null) => accounts.data?.find((a) => a.capability.id === capabilityId)?.capability.name;
  // The account's name leads when the agent chose one; without one the format names the version.
  const versionLabel = (v: (typeof versions)[number], index: number) =>
    [accountName(v.capability_id), t(`posts.format.${v.format}`), String(index + 1)].filter(Boolean).join(' · ');
  const openRedo = () => { setRedoFor(pkg?.revision ?? null); redo.reset(); };
  const editable = manage && !!project && !project.archived;
  const held = (project?.state?.state ?? row?.area.status.state) === 'held';
  // What held the last delivery; a person may accept it only when nothing but its text is held.
  const refusal = project?.refusal;
  const textOnly = !!refusal && refusal.findings.every((v) => v.findings.every((f) => f.kind === 'text'));
  return (
    <section aria-label={t('content.detail.label')} className="min-w-0 space-y-6">
      <MaterialsReadStatus query={detail} />
      {project && (
        <>
          <div className="flex flex-wrap items-start gap-3">
            <p className="min-w-0 flex-1 break-words text-sm text-muted-foreground">{project.brief}</p>
            {!row && project.state && <StateBadge state={project.state.state} />}
            {manage && (
              <Button variant="ghost" size="sm" loading={archive.isPending} onClick={() => archive.mutate(!project.archived)}>
                {t(project.archived ? 'projects.restore' : 'projects.archive')}
              </Button>
            )}
          </div>
          <ProjectError error={archive.error} />
          {project.redo && !project.archived && <p role="status" className="text-sm">{t('contentAreas.redoStatus', { note: project.redo.note })}</p>}
          {editable && held && (
            <Callout tone="warning">
              <div className="min-w-0 space-y-3">
                <p className="text-sm">{t('contentAreas.heldHelp')}</p>
                {refusal && (
                  <section className="space-y-2">
                    <h3 className="text-sm font-medium">{t('contentAreas.heldReasons')}</h3>
                    <ul className="space-y-2 text-sm">
                      {refusal.findings.map((h) => {
                        const v = refusal.versions[h.index];
                        return (
                          <li key={h.index} className="break-words">
                            <p className="font-medium">{v ? versionLabel(v, h.index) : String(h.index + 1)}</p>
                            {v?.text && <p className="whitespace-pre-wrap text-muted-foreground">{v.text}</p>}
                            <ul className="list-disc ps-5">
                              {h.findings.map((f, n) => <li key={n}>{findingText(t, f.code)}{f.matched ? ` (“${f.matched}”)` : ''}</li>)}
                            </ul>
                          </li>
                        );
                      })}
                    </ul>
                    <p className="text-sm text-muted-foreground">{t(textOnly ? 'contentAreas.acceptHelp' : 'contentAreas.notAcceptable')}</p>
                  </section>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={openRedo}>{t('contentAreas.heldAction')}</Button>
                  {textOnly && <Button variant="outline" loading={accept.isPending} onClick={() => accept.mutate(project.revision)}>{t('contentAreas.accept')}</Button>}
                </div>
                <ProjectError error={accept.error} />
              </div>
            </Callout>
          )}
          <div className={row ? 'grid min-w-0 items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]' : 'min-w-0'}>
            {row && (
              <section className="min-w-0 space-y-3">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('content.detail.steps')}</h3>
                <Timeline row={row} files={files} />
              </section>
            )}
            <section className="min-w-0 space-y-4">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('contentAreas.versions')}</h3>
              {pkg && version ? (
                <Tabs value={version.id} onValueChange={setSelected}>
                  {versions.length > 1 && (
                    <TabsList aria-label={t('contentAreas.versions')} className="flex h-auto flex-wrap gap-1">
                      {versions.map((v, index) => <TabsTrigger key={v.id} value={v.id} className="max-w-full whitespace-normal text-start">{versionLabel(v, index)}</TabsTrigger>)}
                    </TabsList>
                  )}
                  <TabsContent value={version.id} className="mt-4 min-w-0 space-y-4 break-words">
                    <PlatformFrame key={version.id} version={version} materials={materials} account={accountName(version.capability_id) ?? t('contentAreas.account')} />
                    <p className="text-sm">{t(`posts.format.${version.format}`)}</p>
                    {version.title && <p className="font-medium">{version.title}</p>}
                    <p className="whitespace-pre-wrap text-sm">{version.text}</p>
                    {version.tags.length > 0 && <p className="text-sm">{version.tags.join(' · ')}</p>}
                    {version.link && <p className="break-all text-sm">{version.link}</p>}
                    <h4 className="text-sm font-medium">{t('contentAreas.usedMaterials')}</h4>
                    <ul className="space-y-1 text-sm">
                      {version.material_ids.map((materialId) => {
                        const used = materials.find((x) => x.id === materialId);
                        return (
                          <li key={materialId}>
                            {files
                              ? <Link className="underline" to={placeHref({ ...place, file: materialId })}>{used ? materialLabel(t, used) : t('contentAreas.missingMaterial')}</Link>
                              : <span>{used ? materialLabel(t, used) : t('contentAreas.missingMaterial')}</span>}
                          </li>
                        );
                      })}
                    </ul>
                    <p className="border-y border-border py-3 text-sm">{t(pkg.released ? 'contentAreas.released' : 'contentAreas.checksPassed')}</p>
                    <section className="space-y-2">
                      <h4 className="font-medium">{t('contentAreas.agentNote')}</h4>
                      <p className="whitespace-pre-wrap text-sm">{pkg.summary}</p>
                    </section>
                  </TabsContent>
                </Tabs>
              ) : (
                <p className="text-sm text-muted-foreground">{t('content.detail.noPackage')}</p>
              )}
              {editable && <Button variant="outline" onClick={openRedo}>{t('contentAreas.redo')}</Button>}
            </section>
          </div>
          <details className="border-t border-border pt-4" open={project.requests.some((r) => r.status === 'open')}>
            <summary className="cursor-pointer py-2 font-medium">{t('contentAreas.requests')}</summary>
            {/* Whoever works here may supply a requested capture. The upload waits in the analysis
                queue first; once filed it can be added here, and taking a source out is the manager's. */}
            <ProjectRequests project={project} materials={materials} writable={!project.archived} onUpload={uploads ? () => { uploads.pick(); setAttach(true); } : undefined} />
            {attach && (
              <div className="mt-4 space-y-3">
                <p className="text-sm text-muted-foreground">{t('content.detail.attachHelp')}</p>
                <ProjectMaterials project={project} materials={materials} writable={editable && files} />
              </div>
            )}
          </details>
          {detail.data && <AreaHistory detail={detail.data} />}
        </>
      )}
      <Dialog open={redoFor !== undefined} onOpenChange={(open) => { if (!open && !redo.isPending) setRedoFor(undefined); }}>
        <DialogContent dismissible={!redo.isPending}>
          <DialogTitle>{t('contentAreas.redo')}</DialogTitle>
          <DialogDescription>{t('contentAreas.redoHelp')}</DialogDescription>
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (note.trim() && !redo.isPending) redo.mutate(undefined); }}>
            <label className="block space-y-2 text-sm"><span>{t('contentAreas.redoNote')}</span><textarea className={fieldClass} required maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} /></label>
            <ProjectError error={redo.error} />
            <Button loading={redo.isPending} disabled={!note.trim()}>{t('contentAreas.redoSubmit')}</Button>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
