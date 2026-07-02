import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Users } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import type { InstallationCrew } from '../../../features/marketing/types';
import {
  Card,
  CardContent,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Field,
  Input,
  Switch,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  EmptyState,
} from '../../../components/ui';

const errMsg = (err: any, fallback: string) =>
  err?.response?.data?.message || fallback;

// ─── Schemas ──────────────────────────────────────────────────────────────────

const crewSchema = z.object({
  name: z.string().min(1, 'Crew name is required'),
  dailyCapacity: z.string().optional(),
  notes: z.string().optional(),
});
type CrewFormValues = z.infer<typeof crewSchema>;

const editCrewSchema = crewSchema.extend({
  active: z.boolean(),
});
type EditCrewFormValues = z.infer<typeof editCrewSchema>;

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  isManager: boolean;
  crews: InstallationCrew[];
  onInvalidate: () => void;
}

export function CrewsTab({ isManager, crews, onInvalidate }: Props) {
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingCrewId, setEditingCrewId] = useState<string | null>(null);

  // Create crew form
  const {
    register: registerCreate,
    handleSubmit: handleCreateSubmit,
    reset: resetCreate,
    formState: { errors: createErrors },
  } = useForm<CrewFormValues>({
    resolver: zodResolver(crewSchema),
    defaultValues: { name: '', dailyCapacity: '', notes: '' },
  });

  // Edit crew form
  const {
    register: registerEdit,
    handleSubmit: handleEditSubmit,
    reset: resetEdit,
    setValue: setEditValue,
    watch: watchEdit,
    formState: { errors: editErrors },
  } = useForm<EditCrewFormValues>({
    resolver: zodResolver(editCrewSchema),
    defaultValues: { name: '', dailyCapacity: '', notes: '', active: true },
  });

  const createCrew = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      marketingApi.post('/installations/crews', payload),
    onSuccess: () => {
      toast.success('Crew created');
      onInvalidate();
      setShowCreateDialog(false);
      resetCreate();
    },
    onError: (e: any) => toast.error(errMsg(e, 'Failed to create crew')),
  });

  const updateCrew = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) =>
      marketingApi.patch(`/installations/crews/${id}`, payload),
    onSuccess: () => {
      toast.success('Crew updated');
      onInvalidate();
      setEditingCrewId(null);
    },
    onError: (e: any) => toast.error(errMsg(e, 'Failed to update crew')),
  });

  function startEdit(c: InstallationCrew) {
    setEditingCrewId(c.id);
    resetEdit({
      name: c.name,
      active: c.active,
      dailyCapacity: String(c.dailyCapacity),
      notes: c.notes || '',
    });
  }

  function onCreateSubmit(values: CrewFormValues) {
    createCrew.mutate({
      name: values.name.trim(),
      dailyCapacity: values.dailyCapacity ? Number(values.dailyCapacity) : undefined,
      notes: values.notes || undefined,
    });
  }

  function onEditSubmit(values: EditCrewFormValues) {
    if (!editingCrewId) return;
    updateCrew.mutate({
      id: editingCrewId,
      payload: {
        name: values.name,
        active: values.active,
        dailyCapacity: values.dailyCapacity ? Number(values.dailyCapacity) : undefined,
        // Send '' (not undefined) so clearing the notes on edit actually blanks
        // them — the PATCH skips undefined, so `|| undefined` silently kept the
        // old notes. UpdateCrewDto.notes has no @IsNotEmpty, so '' is accepted.
        notes: values.notes ?? '',
      },
    });
  }

  const editActive = watchEdit('active');

  return (
    <div className="space-y-4">
      {isManager && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setShowCreateDialog(true)}>
            <Plus className="h-4 w-4" />
            Add Crew
          </Button>
        </div>
      )}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Crew</TH>
                <TH>Capacity / day</TH>
                <TH>Active</TH>
                <TH className="hidden md:table-cell">Notes</TH>
                {isManager && <TH>Actions</TH>}
              </TR>
            </THead>
            <TBody>
              {crews.length === 0 ? (
                <TR>
                  <TD colSpan={isManager ? 5 : 4} className="py-0">
                    <EmptyState
                      icon={<Users className="h-8 w-8" />}
                      title="No crews"
                      description="Add a crew to start scheduling installation jobs."
                      className="rounded-none border-0"
                    />
                  </TD>
                </TR>
              ) : (
                crews.map((c) => (
                  <TR key={c.id}>
                    <TD className="font-medium text-foreground">{c.name}</TD>
                    <TD className="text-muted-foreground">{c.dailyCapacity}</TD>
                    <TD>
                      <Badge tone={c.active ? 'success' : 'neutral'}>
                        {c.active ? 'Active' : 'Inactive'}
                      </Badge>
                    </TD>
                    <TD className="hidden md:table-cell text-muted-foreground text-xs">
                      {c.notes || '—'}
                    </TD>
                    {isManager && (
                      <TD>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => startEdit(c)}
                        >
                          Edit
                        </Button>
                      </TD>
                    )}
                  </TR>
                ))
              )}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      {/* Create crew dialog */}
      <Dialog
        open={showCreateDialog}
        onOpenChange={(open) => { if (!open) { setShowCreateDialog(false); resetCreate(); } }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Crew</DialogTitle>
            <DialogDescription className="sr-only">Fill in the details to add a new crew</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateSubmit(onCreateSubmit)} className="space-y-4">
            <Field label="Crew name" error={createErrors.name?.message} required>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  placeholder="Crew name"
                  {...registerCreate('name')}
                />
              )}
            </Field>
            <Field label="Daily capacity" error={createErrors.dailyCapacity?.message}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  type="number"
                  min={1}
                  max={20}
                  placeholder="Daily capacity"
                  {...registerCreate('dailyCapacity')}
                />
              )}
            </Field>
            <Field label="Notes" error={createErrors.notes?.message}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  placeholder="Notes"
                  {...registerCreate('notes')}
                />
              )}
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => { setShowCreateDialog(false); resetCreate(); }}
              >
                Cancel
              </Button>
              <Button type="submit" loading={createCrew.isPending}>
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit crew dialog */}
      <Dialog
        open={!!editingCrewId}
        onOpenChange={(open) => { if (!open) setEditingCrewId(null); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Crew</DialogTitle>
            <DialogDescription className="sr-only">Update the details for this crew</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleEditSubmit(onEditSubmit)} className="space-y-4">
            <Field label="Crew name" error={editErrors.name?.message} required>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  placeholder="Crew name"
                  {...registerEdit('name')}
                />
              )}
            </Field>
            <Field label="Daily capacity" error={editErrors.dailyCapacity?.message}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  type="number"
                  min={1}
                  max={20}
                  placeholder="Daily capacity"
                  {...registerEdit('dailyCapacity')}
                />
              )}
            </Field>
            <div className="flex items-center gap-3">
              <Switch
                checked={editActive}
                onCheckedChange={(checked) => setEditValue('active', checked)}
              />
              <span className="text-sm text-muted-foreground">
                {editActive ? 'Active' : 'Inactive'}
              </span>
            </div>
            <Field label="Notes" error={editErrors.notes?.message}>
              {({ id, describedBy, invalid }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                  placeholder="Notes"
                  {...registerEdit('notes')}
                />
              )}
            </Field>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditingCrewId(null)}
              >
                Cancel
              </Button>
              <Button type="submit" loading={updateCrew.isPending}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
