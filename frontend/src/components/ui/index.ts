/**
 * Shared UI kit (M2 design-system foundation).
 *
 * The audit found the panel rebuilds Button/Card/Badge/loading states inline on
 * every page with duplicated Tailwind strings — the main driver of the
 * "inconsistent / unfinished" feel. These primitives are the single source of
 * truth pages migrate onto incrementally. Additive: importing them is opt-in,
 * so existing pages keep working untouched until migrated.
 */
export { Button, type ButtonProps } from './Button';
export { IconButton, type IconButtonProps } from './IconButton';
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from './Card';
export { Badge, type BadgeProps } from './Badge';
export { Tag, type TagProps } from './Tag';
export { Separator, type SeparatorProps } from './Separator';
export { Callout, type CalloutProps, type CalloutTone } from './Callout';
export {
  StatCard,
  type StatCardProps,
  type StatCardDelta,
  type StatCardTone,
} from './StatCard';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { Progress, type ProgressProps, type ProgressTone } from './Progress';
export {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedControlOption,
} from './SegmentedControl';
export { ThemeToggle } from './ThemeToggle';
export { Skeleton } from './Skeleton';
export { Spinner } from './Spinner';
export { cn } from './cn';
export { Label } from './Label';
export { Field, type FieldProps } from './Field';
export { Input } from './Input';
export { PhoneInput, normalizePhone, PHONE_PLACEHOLDER } from './PhoneInput';
export { Textarea } from './Textarea';
export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
} from './Select';
export { Checkbox } from './Checkbox';
export { RadioGroup, RadioGroupItem } from './RadioGroup';
export { Switch } from './Switch';
export { Combobox, type ComboboxProps, type ComboboxOption } from './Combobox';
export { DatePicker, type DatePickerProps } from './DatePicker';
export { Slider, type SliderProps } from './Slider';
export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './Dialog';
export {
  Sheet,
  SheetTrigger,
  SheetPortal,
  SheetClose,
  SheetOverlay,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  type SheetContentProps,
} from './Sheet';
export {
  Popover,
  PopoverTrigger,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
} from './Popover';
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuRadioGroup,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from './DropdownMenu';
export {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from './Tooltip';
export { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog';
export { toast, Toaster, type ExternalToast, type ToasterProps } from './Toast';
export { Tabs, TabsList, TabsTrigger, TabsContent } from './Tabs';
export { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from './Accordion';
export { ScrollArea, ScrollBar } from './ScrollArea';
export {
  Avatar,
  AvatarRoot,
  AvatarImage,
  AvatarFallback,
  AvatarGroup,
  type AvatarProps,
  type AvatarGroupProps,
} from './Avatar';
export { Breadcrumbs, type BreadcrumbsProps, type BreadcrumbItem } from './Breadcrumbs';
export { Pagination, type PaginationProps } from './Pagination';
export {
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  type THProps,
  type TDProps,
} from './Table';
export { DataTable, type DataTableProps } from './DataTable';
export { PageHeader, type PageHeaderProps } from './PageHeader';
export { FilterBar, type FilterBarProps, type FilterBarSearchProps } from './FilterBar';
export { LanguageSwitcher } from './LanguageSwitcher';
export { RoleGate, FeatureGate, type RoleGateProps, type FeatureGateProps } from './access-gates';
