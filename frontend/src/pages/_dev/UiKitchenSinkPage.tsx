/**
 * Dev-only UI kitchen-sink page — visual QA gallery for every Console primitive.
 * Accessible only in development builds (guarded at the route level via
 * import.meta.env.DEV). Never ships to production.
 */
import { useState } from 'react';
import { type ColumnDef, type SortingState } from '@tanstack/react-table';
import {
  TooltipProvider,
  Button,
  IconButton,
  Badge,
  Tag,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Callout,
  StatCard,
  EmptyState,
  Progress,
  SegmentedControl,
  ThemeToggle,
  Field,
  Input,
  Textarea,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  Checkbox,
  RadioGroup,
  RadioGroupItem,
  Switch,
  Combobox,
  DatePicker,
  Slider,
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  Popover,
  PopoverTrigger,
  PopoverContent,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  ConfirmDialog,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
  ScrollArea,
  Avatar,
  AvatarGroup,
  Breadcrumbs,
  Pagination,
  DataTable,
  Separator,
  Spinner,
  Skeleton,
  Label,
  Toaster,
  toast,
} from '@/components/ui';
import { Settings, Trash2, Plus, Star } from 'lucide-react';

/* ─── sample data for DataTable ─────────────────────────────────────── */
interface Row {
  id: number;
  name: string;
  role: string;
  status: 'active' | 'inactive';
}

const TABLE_DATA: Row[] = [
  { id: 1, name: 'Aiko Tanaka', role: 'Manager', status: 'active' },
  { id: 2, name: 'Reza Karimi', role: 'Agent', status: 'active' },
  { id: 3, name: 'Sara Novak', role: 'Agent', status: 'inactive' },
];

const TABLE_COLUMNS: ColumnDef<Row, unknown>[] = [
  { accessorKey: 'id', header: 'ID', enableSorting: true },
  { accessorKey: 'name', header: 'Name', enableSorting: true },
  { accessorKey: 'role', header: 'Role', enableSorting: false },
  {
    accessorKey: 'status',
    header: 'Status',
    enableSorting: false,
    cell: ({ getValue }) => {
      const v = getValue() as string;
      return (
        <Badge tone={v === 'active' ? 'success' : 'neutral'}>{v}</Badge>
      );
    },
  },
];

/* ─── Section heading helper ─────────────────────────────────────────── */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-12">
      <h2 className="mb-4 font-display text-h2 text-foreground">{title}</h2>
      <div className="flex flex-wrap items-start gap-3">{children}</div>
    </section>
  );
}

/* ─── Main page ──────────────────────────────────────────────────────── */
export default function UiKitchenSinkPage() {
  /* form state */
  const [inputVal, setInputVal] = useState('');
  const [textareaVal, setTextareaVal] = useState('');
  const [selectVal, setSelectVal] = useState('');
  const [checked, setChecked] = useState(false);
  const [radio, setRadio] = useState('option-a');
  const [switched, setSwitched] = useState(false);
  const [comboVal, setComboVal] = useState('');
  const [dateVal, setDateVal] = useState<Date | null>(null);
  const [sliderVal, setSliderVal] = useState([40]);

  /* overlay state */
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  /* pagination */
  const [page, setPage] = useState(1);

  /* DataTable sorting */
  const [sorting, setSorting] = useState<SortingState>([]);

  /* segmented control */
  const [segment, setSegment] = useState('week');

  return (
    <TooltipProvider>
      <Toaster />
      <div className="min-h-screen bg-background px-6 py-10">
        <div className="mx-auto max-w-5xl">
          {/* Page title */}
          <h1 className="mb-2 font-display text-h1 text-foreground">
            UI Kitchen Sink
          </h1>
          <p className="mb-10 text-sm text-muted-foreground">
            Dev-only visual QA gallery — every Console primitive in one place.
          </p>

          {/* ── Buttons ─────────────────────────────────────────── */}
          <Section title="Buttons">
            {(
              ['primary', 'secondary', 'outline', 'ghost', 'destructive'] as const
            ).flatMap((variant) =>
              (['sm', 'md', 'lg'] as const).map((size) => (
                <Button key={`${variant}-${size}`} variant={variant} size={size}>
                  {variant} {size}
                </Button>
              )),
            )}
            <Button loading>Loading</Button>
            <Button disabled>Disabled</Button>
          </Section>

          {/* ── IconButton ──────────────────────────────────────── */}
          <Section title="IconButton">
            <IconButton aria-label="Settings" variant="ghost">
              <Settings className="h-4 w-4" />
            </IconButton>
            <IconButton aria-label="Delete" variant="outline">
              <Trash2 className="h-4 w-4" />
            </IconButton>
            <IconButton aria-label="Add" variant="primary" size="lg">
              <Plus className="h-4 w-4" />
            </IconButton>
          </Section>

          {/* ── Spinner & Skeleton ──────────────────────────────── */}
          <Section title="Spinner & Skeleton">
            <Spinner />
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-8 w-48" />
          </Section>

          {/* ── Badges ──────────────────────────────────────────── */}
          <Section title="Badges">
            {(
              [
                'neutral',
                'primary',
                'success',
                'warning',
                'danger',
                'info',
              ] as const
            ).map((tone) => (
              <Badge key={tone} tone={tone}>
                {tone}
              </Badge>
            ))}
            {(
              [
                'neutral',
                'primary',
                'success',
                'warning',
                'danger',
                'info',
              ] as const
            ).map((tone) => (
              <Badge key={`${tone}-sm`} tone={tone} size="sm">
                {tone} sm
              </Badge>
            ))}
          </Section>

          {/* ── Tags ────────────────────────────────────────────── */}
          <Section title="Tags">
            <Tag label="Removable" onRemove={() => {}} />
            <Tag label="No remove" />
            <Tag label="Success" tone="success" onRemove={() => {}} />
            <Tag label="Danger" tone="danger" />
          </Section>

          {/* ── Separator ───────────────────────────────────────── */}
          <section className="mb-12">
            <h2 className="mb-4 font-display text-h2 text-foreground">
              Separator
            </h2>
            <div className="w-full">
              <p className="text-sm text-muted-foreground">Above separator</p>
              <Separator className="my-3" />
              <p className="text-sm text-muted-foreground">Below separator</p>
            </div>
          </section>

          {/* ── Card ────────────────────────────────────────────── */}
          <section className="mb-12">
            <h2 className="mb-4 font-display text-h2 text-foreground">Card</h2>
            <Card className="max-w-sm">
              <CardHeader>
                <CardTitle>Card Title</CardTitle>
                <CardDescription>
                  A short description of the card content.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">Card body text.</p>
              </CardContent>
              <CardFooter>
                <Button size="sm">Action</Button>
              </CardFooter>
            </Card>
          </section>

          {/* ── Callouts ────────────────────────────────────────── */}
          <section className="mb-12">
            <h2 className="mb-4 font-display text-h2 text-foreground">
              Callout
            </h2>
            <div className="flex flex-col gap-3 max-w-lg">
              {(
                ['info', 'success', 'warning', 'danger'] as const
              ).map((tone) => (
                <Callout key={tone} tone={tone} title={`${tone} callout`}>
                  This is a {tone} message.
                </Callout>
              ))}
            </div>
          </section>

          {/* ── StatCards ───────────────────────────────────────── */}
          <Section title="StatCard">
            <StatCard label="Total Leads" value="1,284" />
            <StatCard
              label="Revenue"
              value="$48,920"
              delta={{ value: '+12%', direction: 'up' }}
            />
            <StatCard
              label="Churn Rate"
              value="3.2%"
              delta={{ value: '-0.5%', direction: 'down' }}
            />
            <StatCard
              label="Avg Response"
              value="4.1h"
              delta={{ value: '±0', direction: 'flat' }}
            />
          </Section>

          {/* ── EmptyState ──────────────────────────────────────── */}
          <section className="mb-12">
            <h2 className="mb-4 font-display text-h2 text-foreground">
              EmptyState
            </h2>
            <EmptyState
              icon={<Star className="h-8 w-8" />}
              title="No results found"
              description="Try adjusting your filters."
              action={<Button size="sm">Clear filters</Button>}
            />
          </section>

          {/* ── Progress ────────────────────────────────────────── */}
          <section className="mb-12">
            <h2 className="mb-4 font-display text-h2 text-foreground">
              Progress
            </h2>
            <div className="flex flex-col gap-3 max-w-md">
              <Progress value={25} />
              <Progress value={60} tone="success" />
              <Progress value={80} tone="warning" />
              <Progress value={95} tone="danger" />
            </div>
          </section>

          {/* ── SegmentedControl ─────────────────────────────────── */}
          <Section title="SegmentedControl">
            <SegmentedControl
              aria-label="Time period"
              options={[
                { value: 'day', label: 'Day' },
                { value: 'week', label: 'Week' },
                { value: 'month', label: 'Month' },
              ]}
              value={segment}
              onChange={setSegment}
            />
          </Section>

          {/* ── ThemeToggle ─────────────────────────────────────── */}
          <Section title="ThemeToggle">
            <ThemeToggle />
          </Section>

          {/* ── Form ────────────────────────────────────────────── */}
          <section className="mb-12">
            <h2 className="mb-4 font-display text-h2 text-foreground">Form</h2>
            <div className="flex flex-col gap-4 max-w-md">
              <Field label="Name" hint="Enter your full name">
                {({ id, describedBy }) => (
                  <Input
                    id={id}
                    aria-describedby={describedBy}
                    placeholder="e.g. Jane Smith"
                    value={inputVal}
                    onChange={(e) => setInputVal(e.target.value)}
                  />
                )}
              </Field>

              <Field label="Message" error={textareaVal.length > 100 ? 'Too long' : undefined}>
                {({ id, describedBy, invalid }) => (
                  <Textarea
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    placeholder="Your message…"
                    value={textareaVal}
                    onChange={(e) => setTextareaVal(e.target.value)}
                  />
                )}
              </Field>

              <Field label="Role">
                {({ id }) => (
                  <Select value={selectVal} onValueChange={setSelectVal}>
                    <SelectTrigger id={id}>
                      <SelectValue placeholder="Select a role…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manager">Manager</SelectItem>
                      <SelectItem value="agent">Agent</SelectItem>
                      <SelectItem value="viewer">Viewer</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              </Field>

              <div className="flex items-center gap-2">
                <Checkbox
                  id="tos"
                  checked={checked}
                  onCheckedChange={(v) => setChecked(v === true)}
                />
                <Label htmlFor="tos">I agree to the terms</Label>
              </div>

              <RadioGroup value={radio} onValueChange={setRadio}>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="option-a" id="ra" />
                  <Label htmlFor="ra">Option A</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="option-b" id="rb" />
                  <Label htmlFor="rb">Option B</Label>
                </div>
              </RadioGroup>

              <div className="flex items-center gap-2">
                <Switch
                  id="notifications"
                  checked={switched}
                  onCheckedChange={setSwitched}
                />
                <Label htmlFor="notifications">Enable notifications</Label>
              </div>

              <Field label="Country">
                {() => (
                  <Combobox
                    aria-label="Country"
                    options={[
                      { value: 'us', label: 'United States' },
                      { value: 'gb', label: 'United Kingdom' },
                      { value: 'de', label: 'Germany' },
                      { value: 'tr', label: 'Turkey' },
                      { value: 'jp', label: 'Japan' },
                    ]}
                    value={comboVal}
                    onChange={setComboVal}
                    placeholder="Search country…"
                  />
                )}
              </Field>

              <Field label="Date">
                {() => (
                  <DatePicker
                    aria-label="Select date"
                    value={dateVal}
                    onChange={setDateVal}
                  />
                )}
              </Field>

              <Field label="Volume">
                {() => (
                  <Slider
                    min={0}
                    max={100}
                    step={1}
                    value={sliderVal}
                    onValueChange={setSliderVal}
                  />
                )}
              </Field>
            </div>
          </section>

          {/* ── Overlays ────────────────────────────────────────── */}
          <Section title="Overlays">
            {/* Dialog */}
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline">Open Dialog</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Dialog Title</DialogTitle>
                  <DialogDescription>
                    This is a dialog. Press Escape or the X to close.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="outline">Cancel</Button>
                  </DialogClose>
                  <Button onClick={() => setDialogOpen(false)}>Confirm</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            {/* Sheet */}
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetTrigger asChild>
                <Button variant="outline">Open Sheet</Button>
              </SheetTrigger>
              <SheetContent side="right">
                <SheetHeader>
                  <SheetTitle>Sheet Panel</SheetTitle>
                  <SheetDescription>
                    A side panel that slides in from the right.
                  </SheetDescription>
                </SheetHeader>
                <div className="mt-4">
                  <p className="text-sm text-muted-foreground">Sheet content here.</p>
                </div>
              </SheetContent>
            </Sheet>

            {/* Popover */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline">Open Popover</Button>
              </PopoverTrigger>
              <PopoverContent>
                <p className="text-sm">Popover content goes here.</p>
              </PopoverContent>
            </Popover>

            {/* DropdownMenu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">Open Menu</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => toast('Edited')}>
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => toast('Duplicated')}>
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => toast('Deleted')}
                  className="text-danger"
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Tooltip */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost">Hover me</Button>
              </TooltipTrigger>
              <TooltipContent>Tooltip text</TooltipContent>
            </Tooltip>

            {/* ConfirmDialog */}
            <Button
              variant="destructive"
              onClick={() => setConfirmOpen(true)}
            >
              Open ConfirmDialog
            </Button>
            <ConfirmDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              title="Delete this item?"
              description="This action cannot be undone."
              confirmLabel="Delete"
              tone="danger"
              onConfirm={() => {
                toast('Deleted');
                setConfirmOpen(false);
              }}
            />
          </Section>

          {/* ── Tabs ────────────────────────────────────────────── */}
          <section className="mb-12">
            <h2 className="mb-4 font-display text-h2 text-foreground">Tabs</h2>
            <Tabs defaultValue="overview">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="details">Details</TabsTrigger>
                <TabsTrigger value="activity">Activity</TabsTrigger>
              </TabsList>
              <TabsContent value="overview">
                <p className="mt-3 text-sm text-muted-foreground">
                  Overview tab content.
                </p>
              </TabsContent>
              <TabsContent value="details">
                <p className="mt-3 text-sm text-muted-foreground">
                  Details tab content.
                </p>
              </TabsContent>
              <TabsContent value="activity">
                <p className="mt-3 text-sm text-muted-foreground">
                  Activity tab content.
                </p>
              </TabsContent>
            </Tabs>
          </section>

          {/* ── Accordion ───────────────────────────────────────── */}
          <section className="mb-12">
            <h2 className="mb-4 font-display text-h2 text-foreground">
              Accordion
            </h2>
            <Accordion type="single" collapsible className="max-w-lg">
              <AccordionItem value="item-1">
                <AccordionTrigger>What is the Console?</AccordionTrigger>
                <AccordionContent>
                  The Console is the marketing admin interface for managing
                  leads, campaigns, and team performance.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="item-2">
                <AccordionTrigger>How do I reset my password?</AccordionTrigger>
                <AccordionContent>
                  Click "Forgot password" on the login page and follow the
                  instructions sent to your email.
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </section>

          {/* ── ScrollArea ──────────────────────────────────────── */}
          <section className="mb-12">
            <h2 className="mb-4 font-display text-h2 text-foreground">
              ScrollArea
            </h2>
            <ScrollArea className="h-32 w-64 rounded-lg border border-border p-3">
              {Array.from({ length: 20 }, (_, i) => (
                <p key={i} className="text-sm text-muted-foreground">
                  Scroll item {i + 1}
                </p>
              ))}
            </ScrollArea>
          </section>

          {/* ── Avatar & AvatarGroup ────────────────────────────── */}
          <Section title="Avatar & AvatarGroup">
            <Avatar src="https://i.pravatar.cc/40?img=1" initials="AT" size="sm" />
            <Avatar src="https://i.pravatar.cc/40?img=2" initials="RK" size="md" />
            <Avatar src="https://i.pravatar.cc/40?img=3" initials="SN" size="lg" />
            <Avatar initials="AB" size="md" />
            <AvatarGroup
              avatars={[
                { src: 'https://i.pravatar.cc/40?img=4', initials: 'AA' },
                { src: 'https://i.pravatar.cc/40?img=5', initials: 'BB' },
                { src: 'https://i.pravatar.cc/40?img=6', initials: 'CC' },
                { src: 'https://i.pravatar.cc/40?img=7', initials: 'DD' },
                { src: 'https://i.pravatar.cc/40?img=8', initials: 'EE' },
              ]}
              maxVisible={3}
            />
          </Section>

          {/* ── Breadcrumbs ─────────────────────────────────────── */}
          <section className="mb-12">
            <h2 className="mb-4 font-display text-h2 text-foreground">
              Breadcrumbs
            </h2>
            <Breadcrumbs
              items={[
                { label: 'Dashboard', href: '/dashboard' },
                { label: 'Leads', href: '/leads' },
                { label: 'Lead #1284' },
              ]}
            />
          </section>

          {/* ── Pagination ──────────────────────────────────────── */}
          <section className="mb-12">
            <h2 className="mb-4 font-display text-h2 text-foreground">
              Pagination
            </h2>
            <Pagination page={page} pageCount={10} onPage={setPage} />
          </section>

          {/* ── DataTable ───────────────────────────────────────── */}
          <section className="mb-12">
            <h2 className="mb-4 font-display text-h2 text-foreground">
              DataTable
            </h2>
            <DataTable
              columns={TABLE_COLUMNS}
              data={TABLE_DATA}
              sorting={sorting}
              onSortingChange={setSorting}
            />
          </section>
        </div>
      </div>
    </TooltipProvider>
  );
}
