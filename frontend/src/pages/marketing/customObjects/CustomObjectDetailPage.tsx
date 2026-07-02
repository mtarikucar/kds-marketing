import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, ArrowLeft, Database, Archive } from 'lucide-react';
import {
  getObject,
  listFields,
  createField,
  updateField,
  archiveField,
  listRecords,
  createRecord,
  updateRecord,
  deleteRecord,
  type CustomObjectRecord,
} from '../../../features/marketing/api/custom-objects.service';
import type { CustomFieldDef } from '../crm/types';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { CustomFieldFormDialog } from '../crm/customFields/CustomFieldFormDialog';
import type { CustomFieldFormValues } from '../crm/schemas';
import { RecordFormDialog } from './RecordFormDialog';
import {
  PageHeader,
  Button,
  IconButton,
  Badge,
  Card,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  EmptyState,
  Skeleton,
  ConfirmDialog,
  Input,
} from '@/components/ui';
import { useBreadcrumbLabel } from '@/features/marketing/hooks/useBreadcrumbLabel';

function apiError(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
  return Array.isArray(msg) ? msg[0] : (msg ?? fallback);
}

export default function CustomObjectDetailPage() {
  const { key = '' } = useParams<{ key: string }>();
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useMarketingAuthStore((s) => s.user);
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';

  const [search, setSearch] = useState('');
  const [recordOpen, setRecordOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<CustomObjectRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomObjectRecord | null>(null);
  const [fieldOpen, setFieldOpen] = useState(false);
  const [editingField, setEditingField] = useState<CustomFieldDef | null>(null);
  const [archiveFieldTarget, setArchiveFieldTarget] = useState<CustomFieldDef | null>(null);

  // Navigating /custom-objects/:key → another key REUSES this page (no remount,
  // like the lead-detail route). Without resetting, an open dialog or a pending
  // delete/archive CONFIRM for object A's record/field stays open while you view
  // object B — so confirming would act on A's row while the page shows B. Clear
  // all transient state when the object key changes.
  useEffect(() => {
    setSearch('');
    setRecordOpen(false);
    setEditingRecord(null);
    setDeleteTarget(null);
    setFieldOpen(false);
    setEditingField(null);
    setArchiveFieldTarget(null);
  }, [key]);

  const { data: object, isLoading: objectLoading } = useQuery({
    queryKey: ['marketing', 'custom-objects', key],
    queryFn: () => getObject(key),
    enabled: !!key,
  });

  // Show the object's name in the header breadcrumb.
  useBreadcrumbLabel(object?.labelPlural);

  const { data: fields } = useQuery({
    queryKey: ['marketing', 'custom-objects', key, 'fields'],
    queryFn: () => listFields(key),
    enabled: !!key,
  });

  const { data: recordPage, isLoading: recordsLoading } = useQuery({
    queryKey: ['marketing', 'custom-objects', key, 'records', search],
    queryFn: () => listRecords(key, { search: search || undefined }),
    enabled: !!key,
  });

  const activeFields: CustomFieldDef[] = (fields ?? []).filter((f) => !f.archived);
  const records = recordPage?.rows ?? [];
  const objectLabel = object?.labelSingular ?? key;

  const invalidateRecords = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'custom-objects', key, 'records'] });
  const invalidateFields = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'custom-objects', key, 'fields'] });

  // ── Record mutations ─────────────────────────────────────────────────────────

  const saveRecord = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      editingRecord ? updateRecord(editingRecord.id, values) : createRecord(key, values),
    onSuccess: () => {
      invalidateRecords();
      setRecordOpen(false);
      setEditingRecord(null);
      toast.success(t('customObjects.toast.recordSaved', { defaultValue: 'Record saved' }));
    },
    onError: (e) => toast.error(apiError(e, t('customObjects.toast.recordFailed', { defaultValue: 'Failed to save record' }))),
  });

  const removeRecord = useMutation({
    mutationFn: (id: string) => deleteRecord(id),
    onSuccess: () => {
      invalidateRecords();
      setDeleteTarget(null);
      toast.success(t('customObjects.toast.recordDeleted', { defaultValue: 'Record deleted' }));
    },
    onError: (e) => toast.error(apiError(e, t('customObjects.toast.deleteFailed', { defaultValue: 'Failed to delete' }))),
  });

  // ── Field mutations ──────────────────────────────────────────────────────────

  const saveField = useMutation({
    mutationFn: (values: CustomFieldFormValues) => {
      const optionTypes = values.type === 'SELECT' || values.type === 'MULTISELECT';
      if (editingField) {
        return updateField(key, editingField.id, {
          label: values.label,
          required: values.required ?? false,
          ...(optionTypes ? { options: values.options ?? [] } : {}),
        });
      }
      return createField(key, {
        label: values.label,
        key: values.key || undefined,
        type: values.type,
        required: values.required ?? false,
        ...(optionTypes ? { options: values.options ?? [] } : {}),
      });
    },
    onSuccess: () => {
      invalidateFields();
      setFieldOpen(false);
      setEditingField(null);
      toast.success(t('customObjects.toast.fieldSaved', { defaultValue: 'Field saved' }));
    },
    onError: (e) => toast.error(apiError(e, t('customObjects.toast.fieldFailed', { defaultValue: 'Failed to save field' }))),
  });

  const removeField = useMutation({
    mutationFn: (id: string) => archiveField(key, id),
    onSuccess: () => {
      invalidateFields();
      setArchiveFieldTarget(null);
      toast.success(t('customObjects.toast.fieldArchived', { defaultValue: 'Field archived' }));
    },
    onError: (e) => toast.error(apiError(e, t('customObjects.toast.fieldFailed', { defaultValue: 'Failed to archive field' }))),
  });

  if (objectLoading) {
    return <Skeleton className="h-40" />;
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={object?.labelPlural ?? key}
        description={object?.description ?? t('customObjects.detail.subtitle', { defaultValue: 'Browse records and manage fields.' })}
        actions={
          <Button variant="ghost" onClick={() => navigate('/custom-objects')}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t('customObjects.detail.back', { defaultValue: 'All objects' })}
          </Button>
        }
      />

      <Tabs defaultValue="records">
        <TabsList>
          <TabsTrigger value="records">{t('customObjects.tabs.records', { defaultValue: 'Records' })}</TabsTrigger>
          {isManager && <TabsTrigger value="fields">{t('customObjects.tabs.fields', { defaultValue: 'Fields' })}</TabsTrigger>}
        </TabsList>

        {/* ── Records ── */}
        <TabsContent value="records" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Input
              className="max-w-xs"
              placeholder={t('customObjects.searchPlaceholder', { defaultValue: 'Search records…' })}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Button
              onClick={() => {
                setEditingRecord(null);
                setRecordOpen(true);
              }}
              disabled={activeFields.length === 0}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('customObjects.record.new', { defaultValue: 'New record' })}
            </Button>
          </div>

          {recordsLoading ? (
            <Skeleton className="h-40" />
          ) : records.length === 0 ? (
            <EmptyState
              icon={<Database className="h-10 w-10" />}
              title={t('customObjects.record.empty', { defaultValue: 'No records yet' })}
              description={
                activeFields.length === 0
                  ? t('customObjects.record.emptyNoFields', { defaultValue: 'Add fields to this object first, then create records.' })
                  : t('customObjects.record.emptyHint', { defaultValue: 'Create your first record.' })
              }
            />
          ) : (
            <Card className="p-0">
              <Table>
                <THead>
                  <TR>
                    <TH>{t('customObjects.col.name', { defaultValue: 'Name' })}</TH>
                    {activeFields.slice(0, 3).map((f) => (
                      <TH key={f.id}>{f.label}</TH>
                    ))}
                    <TH className="w-24 text-right">{t('common.actions', { defaultValue: 'Actions' })}</TH>
                  </TR>
                </THead>
                <TBody>
                  {records.map((rec) => (
                    <TR key={rec.id}>
                      <TD className="font-medium">{rec.displayName}</TD>
                      {activeFields.slice(0, 3).map((f) => (
                        <TD key={f.id} className="text-muted-foreground">
                          {formatValue(rec.values[f.key])}
                        </TD>
                      ))}
                      <TD className="text-right">
                        <IconButton
                          variant="ghost"
                          size="sm"
                          aria-label={t('common.edit', { defaultValue: 'Edit' })}
                          onClick={() => {
                            setEditingRecord(rec);
                            setRecordOpen(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </IconButton>
                        <IconButton
                          variant="ghost"
                          size="sm"
                          aria-label={t('common.delete', { defaultValue: 'Delete' })}
                          onClick={() => setDeleteTarget(rec)}
                        >
                          <Trash2 className="h-4 w-4 text-danger" aria-hidden="true" />
                        </IconButton>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        {/* ── Fields ── */}
        {isManager && (
          <TabsContent value="fields" className="space-y-3">
            <div className="flex justify-end">
              <Button
                onClick={() => {
                  setEditingField(null);
                  setFieldOpen(true);
                }}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t('customObjects.field.new', { defaultValue: 'New field' })}
              </Button>
            </div>

            {activeFields.length === 0 ? (
              <EmptyState
                title={t('customObjects.field.empty', { defaultValue: 'No fields yet' })}
                description={t('customObjects.field.emptyHint', { defaultValue: 'Add fields to describe this object’s records.' })}
              />
            ) : (
              <Card className="p-0">
                <Table>
                  <THead>
                    <TR>
                      <TH>{t('customObjects.field.label', { defaultValue: 'Label' })}</TH>
                      <TH>{t('customObjects.field.key', { defaultValue: 'Key' })}</TH>
                      <TH>{t('customObjects.field.type', { defaultValue: 'Type' })}</TH>
                      <TH>{t('customObjects.field.required', { defaultValue: 'Required' })}</TH>
                      <TH className="w-24 text-right">{t('common.actions', { defaultValue: 'Actions' })}</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {activeFields.map((f) => (
                      <TR key={f.id}>
                        <TD className="font-medium">{f.label}</TD>
                        <TD className="font-mono text-micro text-muted-foreground">{f.key}</TD>
                        <TD>
                          <Badge tone="neutral" size="sm">{f.type}</Badge>
                        </TD>
                        <TD>{f.required ? t('common.yes', { defaultValue: 'Yes' }) : '—'}</TD>
                        <TD className="text-right">
                          <IconButton
                            variant="ghost"
                            size="sm"
                            aria-label={t('common.edit', { defaultValue: 'Edit' })}
                            onClick={() => {
                              setEditingField(f);
                              setFieldOpen(true);
                            }}
                          >
                            <Pencil className="h-4 w-4" aria-hidden="true" />
                          </IconButton>
                          <IconButton
                            variant="ghost"
                            size="sm"
                            aria-label={t('customObjects.action.archive', { defaultValue: 'Archive' })}
                            onClick={() => setArchiveFieldTarget(f)}
                          >
                            <Archive className="h-4 w-4 text-danger" aria-hidden="true" />
                          </IconButton>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </Card>
            )}
          </TabsContent>
        )}
      </Tabs>

      <RecordFormDialog
        open={recordOpen}
        onOpenChange={(o) => { setRecordOpen(o); if (!o) setEditingRecord(null); }}
        fields={activeFields}
        record={editingRecord}
        objectLabel={objectLabel}
        onSubmit={(values) => saveRecord.mutate(values)}
        isPending={saveRecord.isPending}
      />

      <CustomFieldFormDialog
        open={fieldOpen}
        onOpenChange={(o) => { setFieldOpen(o); if (!o) setEditingField(null); }}
        field={editingField}
        onSubmit={(values) => saveField.mutate(values)}
        isPending={saveField.isPending}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title={t('customObjects.confirm.deleteRecordTitle', { defaultValue: 'Delete record' })}
        description={t('customObjects.confirm.deleteRecordBody', { defaultValue: 'This permanently deletes the record and its contact links.' })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        onConfirm={() => deleteTarget && removeRecord.mutate(deleteTarget.id)}
        loading={removeRecord.isPending}
      />

      <ConfirmDialog
        open={!!archiveFieldTarget}
        onOpenChange={(o) => { if (!o) setArchiveFieldTarget(null); }}
        title={t('customObjects.confirm.archiveFieldTitle', { defaultValue: 'Archive field' })}
        description={t('customObjects.confirm.archiveFieldBody', { defaultValue: 'The field is hidden from new records. Existing values are kept.' })}
        confirmLabel={t('customObjects.action.archive', { defaultValue: 'Archive' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        onConfirm={() => archiveFieldTarget && removeField.mutate(archiveFieldTarget.id)}
        loading={removeField.isPending}
      />
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? '✓' : '—';
  return String(v).slice(0, 60);
}
