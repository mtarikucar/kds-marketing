import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { projectGet, projectUpdate } from '@/api/projects';
import { areaRedo, deliveryAccept } from '@/api/content';
import { listCapabilities } from '@/api/capabilities';
import { Button, Callout, Dialog, DialogContent, DialogDescription, DialogTitle, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui';
import { fieldClass, findingText, materialLabel, MaterialsReadStatus, useMaterialsKey, useMaterialsMutation } from '../materials/MaterialsShared';
import { ProjectRequests } from '../projects/ProjectRequests';
import { ProjectMaterials } from '../projects/ProjectMaterials';
import { ProjectError } from '../projects/ProjectShared';
import { AREA_STEPS, stepName, AreaBadge, areaSentence, areaState, currentPackage, openedBy } from './AreaShared';
import { PlatformFrame } from './PlatformFrame';
import { AreaHistory } from './AreaHistory';

/**
 * One production area: its goal and state, the platform versions of its current package (one at
 * a time, in the platform's frame), the agent's steps and its material requests. Nobody approves
 * here: a person says "Olmamış" with what should change, or archives the area.
 */
export function AreaPage({ id, manage }: { id: string; manage: boolean }) {
  const { t } = useTranslation();
  const key = useMaterialsKey();
  const client = useQueryClient();
  const detailKey = [...key, 'areas', id];
  const detail = useQuery({ queryKey: detailKey, queryFn: () => projectGet(id), refetchInterval: 15_000 });
  const accounts = useQuery({ queryKey: [...key, 'social-accounts'], queryFn: () => listCapabilities({ group: 'social_account', status: 'verified' }) });
  const [selected, setSelected] = useState('');
  // The package the person was looking at when they opened the dialog (`null`: none yet);
  // `undefined`: the dialog is closed. The note is about that package, whatever arrives meanwhile.
  const [redoFor, setRedoFor] = useState<number | null>();
  const [note, setNote] = useState('');
  const [upload, setUpload] = useState(false);
  const redo = useMaterialsMutation(
    () => areaRedo(id, { package_revision: redoFor ?? null, note: note.trim() }),
    result => { client.setQueryData(detailKey, result); setRedoFor(undefined); setNote(''); },
  );
  const accept = useMaterialsMutation(
    (expected_revision: number) => deliveryAccept(id, { expected_revision }),
    result => client.setQueryData(detailKey, result),
  );
  // An agent reporting its steps moves the area's revision; archive what is there now.
  const archive = useMaterialsMutation(async (archived: boolean) =>
    projectUpdate(id, { expected_revision: (await projectGet(id)).project.revision, archived }));
  const project = detail.data?.project;
  const pkg = project && currentPackage(project);
  const versions = pkg?.versions ?? [];
  const version = versions.find(v => v.id === selected) ?? versions[0];
  const materials = detail.data?.materials ?? [];
  const accountName = (capabilityId: string | null) => accounts.data?.find(a => a.capability.id === capabilityId)?.capability.name;
  // The account's name leads when the agent chose one; without one the format names the version.
  const versionLabel = (v: (typeof versions)[number], index: number) =>
    [accountName(v.capability_id), t(`posts.format.${v.format}`), String(index + 1)].filter(Boolean).join(' · ');
  const openRedo = () => { setRedoFor(pkg?.revision ?? null); redo.reset(); };
  const editable = manage && !!project && !project.archived;
  // What held the last delivery; a person may accept it only when nothing but its text is held.
  const refusal = project?.refusal;
  const textOnly = !!refusal && refusal.findings.every(v => v.findings.every(f => f.kind === 'text'));
  return <section className="min-w-0 space-y-6">
    <Link to="/content" className="inline-flex min-h-10 items-center text-sm underline">{t('contentAreas.back')}</Link>
    <MaterialsReadStatus query={detail} />
    {project && <>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="min-w-0 break-words text-2xl font-medium">{project.title}</h2>
          <AreaBadge area={project} />
          {manage && <Button variant="ghost" size="sm" className="ms-auto" loading={archive.isPending} onClick={() => archive.mutate(!project.archived)}>
            {t(project.archived ? 'projects.restore' : 'projects.archive')}
          </Button>}
        </div>
        <p className="break-words text-muted-foreground">{project.brief}</p>
        <p className="text-xs text-muted-foreground">{openedBy(t, project)}</p>
        <ProjectError error={archive.error} />
      </header>
      <p role="status" className={pkg ? 'break-words text-sm text-muted-foreground' : 'break-words border-s-2 border-primary bg-surface-muted px-5 py-8'}>{areaSentence(t, project)}</p>
      {editable && areaState(project) === 'held' && <Callout tone="warning">
        <div className="min-w-0 space-y-3">
          <p className="text-sm">{t('contentAreas.heldHelp')}</p>
          {refusal && <section className="space-y-2">
            <h3 className="text-sm font-medium">{t('contentAreas.heldReasons')}</h3>
            <ul className="space-y-2 text-sm">
              {refusal.findings.map(held => {
                const v = refusal.versions[held.index];
                return <li key={held.index} className="break-words">
                  <p className="font-medium">{v ? versionLabel(v, held.index) : String(held.index + 1)}</p>
                  {v?.text && <p className="whitespace-pre-wrap text-muted-foreground">{v.text}</p>}
                  <ul className="list-disc ps-5">
                    {held.findings.map((f, n) => <li key={n}>{findingText(t, f.code)}{f.matched ? ` (“${f.matched}”)` : ''}</li>)}
                  </ul>
                </li>;
              })}
            </ul>
            <p className="text-sm text-muted-foreground">{t(textOnly ? 'contentAreas.acceptHelp' : 'contentAreas.notAcceptable')}</p>
          </section>}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={openRedo}>{t('contentAreas.heldAction')}</Button>
            {textOnly && <Button variant="outline" loading={accept.isPending} onClick={() => accept.mutate(project.revision)}>{t('contentAreas.accept')}</Button>}
          </div>
          <ProjectError error={accept.error} />
        </div>
      </Callout>}
      {pkg && version && <Tabs value={version.id} onValueChange={setSelected}>
        <TabsList aria-label={t('contentAreas.versions')} className="flex h-auto flex-wrap gap-1">
          {versions.map((v, index) => <TabsTrigger key={v.id} value={v.id} className="max-w-full whitespace-normal text-start">{versionLabel(v, index)}</TabsTrigger>)}
        </TabsList>
        <TabsContent value={version.id} className="mt-6 grid min-w-0 items-start gap-8 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
          <PlatformFrame key={version.id} version={version} materials={materials} account={accountName(version.capability_id) ?? t('contentAreas.account')} />
          <div className="min-w-0 space-y-5 break-words">
            <section className="space-y-3">
              <h3 className="font-medium">{t('contentAreas.versionSummary')}</h3>
              <p>{t(`posts.format.${version.format}`)}</p>
              {version.title && <p className="font-medium">{version.title}</p>}
              <p className="whitespace-pre-wrap text-sm">{version.text}</p>
              {version.tags.length > 0 && <p className="text-sm">{version.tags.join(' · ')}</p>}
              {version.link && <p className="break-all text-sm">{version.link}</p>}
              <h4 className="text-sm font-medium">{t('contentAreas.usedMaterials')}</h4>
              <ul className="space-y-1 text-sm">
                {version.material_ids.map(materialId => {
                  const used = materials.find(m => m.id === materialId);
                  return <li key={materialId}><Link className="underline" to={`/materials?view=library&material=${encodeURIComponent(materialId)}`}>{used ? materialLabel(t, used) : t('contentAreas.missingMaterial')}</Link></li>;
                })}
              </ul>
            </section>
            <p className="border-y border-border py-3 text-sm">{t(pkg.released ? 'contentAreas.released' : 'contentAreas.checksPassed')}</p>
            <section className="space-y-2"><h3 className="font-medium">{t('contentAreas.agentNote')}</h3><p className="whitespace-pre-wrap text-sm">{pkg.summary}</p></section>
            {editable && <Button variant="outline" onClick={openRedo}>{t('contentAreas.redo')}</Button>}
          </div>
        </TabsContent>
      </Tabs>}
      <details className="border-t border-border pt-4">
        <summary className="cursor-pointer py-2 font-medium">{t('contentAreas.progress')}</summary>
        <ol aria-label={t('contentAreas.stepsLabel')} className="mt-3 grid gap-2 sm:grid-cols-2">
          {AREA_STEPS.map(step => <li key={step} aria-current={(project.state?.step ?? project.progress?.step) === step ? 'step' : undefined} className="flex gap-3 rounded px-3 py-2 text-sm aria-[current=step]:bg-primary/10 aria-[current=step]:font-medium"><span className="tabular-nums text-muted-foreground">{step}</span><span>{stepName(t, step)}</span></li>)}
        </ol>
        {(project.progress?.note || project.state?.note) && <p className="mt-4 break-words text-sm">{project.progress?.note || project.state?.note}</p>}
      </details>
      <details className="border-t border-border pt-4">
        <summary className="cursor-pointer py-2 font-medium">{t('contentAreas.requests')}</summary>
        {/* Whoever works here may supply a requested capture; taking a source out is the manager's. */}
        <ProjectRequests project={project} materials={materials} writable={!project.archived} onUpload={() => setUpload(true)} />
        {upload && <ProjectMaterials project={project} materials={materials} writable={editable} />}
      </details>
      {detail.data && <AreaHistory detail={detail.data} />}
    </>}
    <Dialog open={redoFor !== undefined} onOpenChange={open => { if (!open && !redo.isPending) setRedoFor(undefined); }}>
      <DialogContent dismissible={!redo.isPending}>
        <DialogTitle>{t('contentAreas.redo')}</DialogTitle>
        <DialogDescription>{t('contentAreas.redoHelp')}</DialogDescription>
        <form className="space-y-4" onSubmit={e => { e.preventDefault(); if (note.trim() && !redo.isPending) redo.mutate(undefined); }}>
          <label className="block space-y-2 text-sm"><span>{t('contentAreas.redoNote')}</span><textarea className={fieldClass} required maxLength={2000} value={note} onChange={e => setNote(e.target.value)} /></label>
          <ProjectError error={redo.error} />
          <Button loading={redo.isPending} disabled={!note.trim()}>{t('contentAreas.redoSubmit')}</Button>
        </form>
      </DialogContent>
    </Dialog>
  </section>;
}
