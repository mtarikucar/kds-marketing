import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ColumnDef } from '@tanstack/react-table';
import {
  Plus,
  Pencil,
  Trash2,
  PhoneCall,
  ListTree,
  Phone,
  Voicemail,
  PhoneOff,
  Sparkles,
  Hash,
} from 'lucide-react';
import marketingApi from '../../../../features/marketing/api/marketingApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { cn } from '@/components/ui/cn';
import { MenuFormDialog } from './MenuFormDialog';
import { OptionFormDialog } from './OptionFormDialog';
import { IvrTree } from './IvrTree';
import {
  type IvrMenu,
  type IvrOption,
  type IvrAction,
  type MenuFormValues,
  type OptionFormValues,
  ACTION_LABELS,
} from './schema';

type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const ACTION_TONE: Record<IvrAction, BadgeTone> = {
  SUBMENU: 'primary',
  DIAL: 'info',
  VOICEMAIL: 'warning',
  HANGUP: 'neutral',
  AI_RECEPTIONIST: 'success',
};

const ACTION_ICON: Record<IvrAction, typeof Phone> = {
  SUBMENU: ListTree,
  DIAL: Phone,
  VOICEMAIL: Voicemail,
  HANGUP: PhoneOff,
  AI_RECEPTIONIST: Sparkles,
};

const QK = ['marketing', 'ivr', 'menus'];

export default function IvrMenusPage() {
  const queryClient = useQueryClient();
  const { t } = useTranslation('marketing');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menuFormOpen, setMenuFormOpen] = useState(false);
  const [editingMenu, setEditingMenu] = useState<IvrMenu | null>(null);
  const [optionFormOpen, setOptionFormOpen] = useState(false);
  const [deleteMenuTarget, setDeleteMenuTarget] = useState<IvrMenu | null>(null);
  const [deleteOptionTarget, setDeleteOptionTarget] = useState<IvrOption | null>(null);

  // ── Query ────────────────────────────────────────────────────────────────
  const { data, isLoading } = useQuery({
    queryKey: QK,
    queryFn: () => marketingApi.get('/ivr/menus').then((r) => r.data),
  });

  const menus: IvrMenu[] = useMemo(() => (Array.isArray(data) ? data : (data?.data ?? [])), [data]);
  const selectedMenu = useMemo(
    () => menus.find((m) => m.id === selectedId) ?? null,
    [menus, selectedId],
  );

  const invalidate = () => queryClient.invalidateQueries({ queryKey: QK });
  const errMsg = (e: unknown, fallback: string) =>
    ((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback);

  // ── Mutations ──────────────────────────────────────────────────────────────
  const createMenu = useMutation({
    mutationFn: (payload: MenuFormValues) => marketingApi.post('/ivr/menus', payload),
    onSuccess: (res) => {
      invalidate();
      setMenuFormOpen(false);
      setEditingMenu(null);
      const id = (res?.data as { id?: string } | undefined)?.id;
      if (id) setSelectedId(id);
      toast.success(t('ivr.menu.created', { defaultValue: 'Menu created' }));
    },
    onError: (e) => toast.error(errMsg(e, t('ivr.menu.createFailed', { defaultValue: 'Failed to create menu' }))),
  });

  const updateMenu = useMutation({
    mutationFn: ({ id, data }: { id: string; data: MenuFormValues }) =>
      marketingApi.patch(`/ivr/menus/${id}`, data),
    onSuccess: () => {
      invalidate();
      setMenuFormOpen(false);
      setEditingMenu(null);
      toast.success(t('ivr.menu.updated', { defaultValue: 'Menu updated' }));
    },
    onError: (e) => toast.error(errMsg(e, t('ivr.menu.updateFailed', { defaultValue: 'Failed to update menu' }))),
  });

  const deleteMenu = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/ivr/menus/${id}`),
    onSuccess: (_res, id) => {
      invalidate();
      setDeleteMenuTarget(null);
      if (selectedId === id) setSelectedId(null);
      toast.success(t('ivr.menu.deleted', { defaultValue: 'Menu deleted' }));
    },
    onError: (e) => toast.error(errMsg(e, t('ivr.menu.deleteFailed', { defaultValue: 'Failed to delete menu' }))),
  });

  const addOption = useMutation({
    mutationFn: ({ menuId, data }: { menuId: string; data: Record<string, unknown> }) =>
      marketingApi.post(`/ivr/menus/${menuId}/options`, data),
    onSuccess: () => {
      invalidate();
      setOptionFormOpen(false);
      toast.success(t('ivr.option.added', { defaultValue: 'Option added' }));
    },
    onError: (e) => toast.error(errMsg(e, t('ivr.option.addFailed', { defaultValue: 'Failed to add option' }))),
  });

  const deleteOption = useMutation({
    mutationFn: ({ menuId, optionId }: { menuId: string; optionId: string }) =>
      marketingApi.delete(`/ivr/menus/${menuId}/options/${optionId}`),
    onSuccess: () => {
      invalidate();
      setDeleteOptionTarget(null);
      toast.success(t('ivr.option.deleted', { defaultValue: 'Option removed' }));
    },
    onError: (e) => toast.error(errMsg(e, t('ivr.option.deleteFailed', { defaultValue: 'Failed to remove option' }))),
  });

  // ── Handlers ───────────────────────────────────────────────────────────────
  const openCreateMenu = () => {
    setEditingMenu(null);
    setMenuFormOpen(true);
  };
  const openEditMenu = (menu: IvrMenu) => {
    setEditingMenu(menu);
    setMenuFormOpen(true);
  };
  const handleMenuSubmit = (values: MenuFormValues) => {
    if (editingMenu) updateMenu.mutate({ id: editingMenu.id, data: values });
    else createMenu.mutate(values);
  };
  const handleOptionSubmit = (values: OptionFormValues) => {
    if (!selectedMenu) return;
    const payload: Record<string, unknown> = {
      digit: values.digit,
      label: values.label,
      action: values.action,
      ...(values.action === 'SUBMENU' && values.targetMenuId
        ? { targetMenuId: values.targetMenuId }
        : {}),
      ...(values.action === 'DIAL' && values.dialNumber ? { dialNumber: values.dialNumber } : {}),
    };
    addOption.mutate({ menuId: selectedMenu.id, data: payload });
  };

  // ── Menu list columns ──────────────────────────────────────────────────────
  const columns: ColumnDef<IvrMenu, unknown>[] = [
    {
      accessorKey: 'name',
      header: t('ivr.menu.name', { defaultValue: 'Name' }),
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{row.original.name}</span>
          {row.original.isRoot && (
            <Badge tone="primary" size="sm">
              {t('ivr.tree.root', { defaultValue: 'Root' })}
            </Badge>
          )}
        </div>
      ),
    },
    {
      accessorKey: 'enabled',
      header: t('ivr.menu.status', { defaultValue: 'Status' }),
      cell: ({ getValue }) => {
        const enabled = getValue<boolean>();
        return (
          <Badge tone={enabled ? 'success' : 'neutral'} size="sm">
            {enabled
              ? t('ivr.menu.enabledBadge', { defaultValue: 'Enabled' })
              : t('ivr.menu.disabledBadge', { defaultValue: 'Disabled' })}
          </Badge>
        );
      },
    },
    {
      id: 'options',
      header: t('ivr.menu.optionsCount', { defaultValue: 'Options' }),
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">{row.original.options.length}</span>
      ),
    },
    {
      id: 'actions',
      header: '',
      size: 80,
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-1">
          <IconButton
            aria-label={t('common.edit', { defaultValue: 'Edit' })}
            size="sm"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              openEditMenu(row.original);
            }}
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </IconButton>
          <IconButton
            aria-label={t('common.delete', { defaultValue: 'Delete' })}
            size="sm"
            variant="ghost"
            className="text-danger"
            onClick={(e) => {
              e.stopPropagation();
              setDeleteMenuTarget(row.original);
            }}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        </div>
      ),
    },
  ];

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">
      <PageHeader
        title={t('ivr.title', { defaultValue: 'Phone tree' })}
        description={t('ivr.subtitle', {
          defaultValue: 'Build IVR menus that greet callers and route them by keypad before the AI receptionist.',
        })}
        actions={
          <Button onClick={openCreateMenu}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('ivr.menu.createButton', { defaultValue: 'New menu' })}
          </Button>
        }
      />

      <Tabs defaultValue="builder">
        <TabsList>
          <TabsTrigger value="builder">
            {t('ivr.tabs.builder', { defaultValue: 'Builder' })}
          </TabsTrigger>
          <TabsTrigger value="tree">
            {t('ivr.tabs.tree', { defaultValue: 'Tree' })}
          </TabsTrigger>
        </TabsList>

        {/* Builder: menu list + selected-menu option editor */}
        <TabsContent value="builder">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
            {/* Menu list */}
            <Card>
              <CardHeader>
                <CardTitle>{t('ivr.menu.listTitle', { defaultValue: 'Menus' })}</CardTitle>
                <CardDescription>
                  {t('ivr.menu.listHint', { defaultValue: 'Select a menu to edit its keypad options.' })}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <DataTable
                  columns={columns}
                  data={menus}
                  isLoading={isLoading}
                  loadingRowCount={4}
                  onRowClick={(m) => setSelectedId(m.id)}
                  emptyState={
                    <EmptyState
                      icon={<PhoneCall className="h-10 w-10" />}
                      title={t('ivr.menu.empty', { defaultValue: 'No menus yet' })}
                      description={t('ivr.menu.emptyHint', {
                        defaultValue: 'Create your first menu to start building the phone tree.',
                      })}
                      action={
                        <Button onClick={openCreateMenu} variant="outline">
                          <Plus className="h-4 w-4" aria-hidden="true" />
                          {t('ivr.menu.createButton', { defaultValue: 'New menu' })}
                        </Button>
                      }
                    />
                  }
                />
              </CardContent>
            </Card>

            {/* Selected-menu option editor */}
            <Card>
              {selectedMenu ? (
                <>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <CardTitle className="truncate">{selectedMenu.name}</CardTitle>
                        <CardDescription className="line-clamp-2">{selectedMenu.greeting}</CardDescription>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setOptionFormOpen(true)}
                      >
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        {t('ivr.option.add', { defaultValue: 'Add option' })}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {selectedMenu.options.length === 0 ? (
                      <EmptyState
                        icon={<Hash className="h-8 w-8" />}
                        title={t('ivr.option.empty', { defaultValue: 'No keypad options' })}
                        description={t('ivr.option.emptyHint', {
                          defaultValue: 'Map a digit to send callers to a submenu, a number, voicemail, or the AI.',
                        })}
                      />
                    ) : (
                      <ul className="divide-y divide-border">
                        {selectedMenu.options.map((opt) => {
                          const Icon = ACTION_ICON[opt.action] ?? Hash;
                          const target =
                            opt.action === 'SUBMENU' && opt.targetMenuId
                              ? menus.find((m) => m.id === opt.targetMenuId)
                              : undefined;
                          return (
                            <li key={opt.id} className="flex items-center gap-3 py-2.5">
                              <span
                                className={cn(
                                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                                  'bg-surface-muted font-mono text-sm font-semibold text-foreground',
                                )}
                                aria-hidden="true"
                              >
                                {opt.digit}
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium text-foreground">{opt.label}</p>
                                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                  <Icon className="h-3 w-3" aria-hidden="true" />
                                  {t(`ivr.actions.${opt.action}`, { defaultValue: ACTION_LABELS[opt.action] })}
                                  {opt.action === 'DIAL' && opt.dialNumber && (
                                    <span className="font-mono">· {opt.dialNumber}</span>
                                  )}
                                  {opt.action === 'SUBMENU' && (
                                    <span>· {target ? target.name : t('ivr.tree.missingTarget', { defaultValue: 'target menu not found' })}</span>
                                  )}
                                </p>
                              </div>
                              <Badge tone={ACTION_TONE[opt.action] ?? 'neutral'} size="sm">
                                {t(`ivr.actions.${opt.action}`, { defaultValue: ACTION_LABELS[opt.action] })}
                              </Badge>
                              <IconButton
                                aria-label={t('common.delete', { defaultValue: 'Delete' })}
                                size="sm"
                                variant="ghost"
                                className="text-danger"
                                onClick={() => setDeleteOptionTarget(opt)}
                              >
                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                              </IconButton>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </CardContent>
                </>
              ) : (
                <CardContent>
                  <EmptyState
                    icon={<ListTree className="h-10 w-10" />}
                    title={t('ivr.selectPrompt', { defaultValue: 'Select a menu' })}
                    description={t('ivr.selectPromptHint', {
                      defaultValue: 'Pick a menu on the left to view and edit its keypad options.',
                    })}
                  />
                </CardContent>
              )}
            </Card>
          </div>
        </TabsContent>

        {/* Tree visualization */}
        <TabsContent value="tree">
          <Card>
            <CardHeader>
              <CardTitle>{t('ivr.tree.title', { defaultValue: 'Phone tree' })}</CardTitle>
              <CardDescription>
                {t('ivr.tree.subtitle', {
                  defaultValue: 'How an inbound call flows from the root menu through your keypad options.',
                })}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {menus.length === 0 ? (
                <EmptyState
                  icon={<ListTree className="h-10 w-10" />}
                  title={t('ivr.menu.empty', { defaultValue: 'No menus yet' })}
                  description={t('ivr.tree.emptyHint', {
                    defaultValue: 'Create menus and options to see the call flow visualized here.',
                  })}
                />
              ) : (
                <IvrTree menus={menus} />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Menu create / edit */}
      <MenuFormDialog
        open={menuFormOpen}
        onOpenChange={(open) => {
          setMenuFormOpen(open);
          if (!open) setEditingMenu(null);
        }}
        menu={editingMenu}
        onSubmit={handleMenuSubmit}
        isPending={createMenu.isPending || updateMenu.isPending}
      />

      {/* Option add */}
      <OptionFormDialog
        open={optionFormOpen}
        onOpenChange={setOptionFormOpen}
        menu={selectedMenu}
        allMenus={menus}
        onSubmit={handleOptionSubmit}
        isPending={addOption.isPending}
      />

      {/* Delete menu confirm */}
      <ConfirmDialog
        open={!!deleteMenuTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteMenuTarget(null);
        }}
        title={t('ivr.menu.deleteTitle', { defaultValue: 'Delete menu' })}
        description={t('ivr.menu.deleteConfirm', {
          defaultValue:
            'This permanently removes the menu and its options. A menu still targeted by a submenu option cannot be deleted.',
        })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        onConfirm={() => deleteMenuTarget && deleteMenu.mutate(deleteMenuTarget.id)}
        loading={deleteMenu.isPending}
      />

      {/* Delete option confirm */}
      <ConfirmDialog
        open={!!deleteOptionTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteOptionTarget(null);
        }}
        title={t('ivr.option.deleteTitle', { defaultValue: 'Remove option' })}
        description={t('ivr.option.deleteConfirm', {
          defaultValue: 'This removes the keypad option from this menu.',
        })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        onConfirm={() =>
          deleteOptionTarget &&
          deleteOption.mutate({ menuId: deleteOptionTarget.menuId, optionId: deleteOptionTarget.id })
        }
        loading={deleteOption.isPending}
      />
    </div>
  );
}
