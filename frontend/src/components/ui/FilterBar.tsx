import { Search } from 'lucide-react';
import { cn } from './cn';
import { Input } from './Input';

export interface FilterBarSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export interface FilterBarProps {
  search?: FilterBarSearchProps;
  children?: React.ReactNode;
  right?: React.ReactNode;
  className?: string;
}

export function FilterBar({ search, children, right, className }: FilterBarProps) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {search && (
        <div className="relative flex items-center">
          <Search
            className="absolute start-2.5 h-4 w-4 text-muted-foreground pointer-events-none"
            aria-hidden="true"
          />
          <Input
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder ?? 'Search…'}
            className="ps-8 w-60"
            aria-label={search.placeholder ?? 'Search'}
          />
        </div>
      )}
      {children}
      {right && (
        <div className="ms-auto flex items-center gap-2">
          {right}
        </div>
      )}
    </div>
  );
}
