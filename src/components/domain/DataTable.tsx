/**
 * Data table.
 *
 * Used by every CMS list view, so sorting, searching, empty states and
 * responsive behaviour are solved once. Below the `md` breakpoint each row
 * collapses into a card, because a horizontally scrolling table is unusable
 * on a phone and this CMS is genuinely used on tablets during home visits.
 */

import * as React from 'react';
import { ArrowUpDown, ChevronDown, ChevronUp, Search, SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, Card, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';

export interface Column<T> {
  /** Stable key, also used as the React key. */
  key: string;
  header: string;
  /** Cell renderer. */
  cell: (row: T) => React.ReactNode;
  /** Value used for sorting; omit to make the column unsortable. */
  sortValue?: (row: T) => string | number;
  /** Hide below md; the value still appears in the mobile card. */
  hideOnMobile?: boolean;
  /** Right-align, typically for numbers and action buttons. */
  align?: 'left' | 'right';
  className?: string;
  /** Exclude from the mobile card entirely (e.g. duplicate of the title). */
  primary?: boolean;
}

export interface FilterOption {
  key: string;
  label: string;
  options: { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}

export function DataTable<T>({
  rows,
  columns,
  getRowKey,
  searchPlaceholder = '搜尋…',
  searchFields,
  filters,
  emptyState,
  initialSort,
  onRowClick,
  className,
  toolbar,
}: {
  rows: T[];
  columns: Column<T>[];
  getRowKey: (row: T) => string;
  searchPlaceholder?: string;
  /** Fields searched by the text box. Omit to hide search. */
  searchFields?: (row: T) => string;
  filters?: FilterOption[];
  emptyState?: React.ReactNode;
  initialSort?: { key: string; direction: 'asc' | 'desc' };
  onRowClick?: (row: T) => void;
  className?: string;
  toolbar?: React.ReactNode;
}) {
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState<{ key: string; direction: 'asc' | 'desc' } | null>(
    initialSort ?? null,
  );

  const filtered = React.useMemo(() => {
    let result = rows;

    if (query.trim() && searchFields) {
      const needle = query.trim().toLowerCase();
      result = result.filter((row) => searchFields(row).toLowerCase().includes(needle));
    }

    if (sort) {
      const column = columns.find((c) => c.key === sort.key);
      if (column?.sortValue) {
        const getValue = column.sortValue;
        result = [...result].sort((a, b) => {
          const av = getValue(a);
          const bv = getValue(b);
          const cmp =
            typeof av === 'number' && typeof bv === 'number'
              ? av - bv
              : String(av).localeCompare(String(bv), 'zh-TW');
          return sort.direction === 'asc' ? cmp : -cmp;
        });
      }
    }

    return result;
  }, [rows, query, sort, columns, searchFields]);

  const toggleSort = (key: string) => {
    setSort((current) => {
      if (current?.key !== key) return { key, direction: 'asc' };
      if (current.direction === 'asc') return { key, direction: 'desc' };
      return null;
    });
  };

  const hasControls = Boolean(searchFields || filters?.length || toolbar);

  return (
    <div className={cn('space-y-4', className)}>
      {hasControls && (
        <div className="flex flex-wrap items-center gap-2">
          {searchFields && (
            <div className="relative min-w-[200px] flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="pl-9"
                aria-label={searchPlaceholder}
              />
            </div>
          )}

          {filters?.map((filter) => (
            <Select key={filter.key} value={filter.value} onValueChange={filter.onChange}>
              <SelectTrigger className="w-auto min-w-[130px]" aria-label={filter.label}>
                <SlidersHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
                <SelectValue placeholder={filter.label} />
              </SelectTrigger>
              <SelectContent>
                {filter.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}

          {toolbar}

          <span className="tabular ml-auto shrink-0 text-xs text-muted-foreground">
            共 {filtered.length} 筆
            {filtered.length !== rows.length && ` / ${rows.length}`}
          </span>
        </div>
      )}

      {filtered.length === 0 ? (
        emptyState ?? (
          <Card className="border-dashed p-10 text-center text-sm text-muted-foreground shadow-none">
            {query ? `找不到符合「${query}」的資料。` : '目前沒有資料。'}
          </Card>
        )
      ) : (
        <>
          {/* ------------------------ Desktop table ------------------------ */}
          <Card className="hidden overflow-hidden md:block">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    {columns.map((column) => (
                      <th
                        key={column.key}
                        scope="col"
                        className={cn(
                          'whitespace-nowrap px-4 py-3 text-xs font-semibold text-muted-foreground',
                          column.align === 'right' ? 'text-right' : 'text-left',
                          column.hideOnMobile && 'hidden lg:table-cell',
                        )}
                        aria-sort={
                          sort?.key === column.key
                            ? sort.direction === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : undefined
                        }
                      >
                        {column.sortValue ? (
                          <button
                            type="button"
                            onClick={() => toggleSort(column.key)}
                            className={cn(
                              'inline-flex items-center gap-1 rounded transition-colors hover:text-foreground',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              column.align === 'right' && 'flex-row-reverse',
                            )}
                          >
                            {column.header}
                            {sort?.key === column.key ? (
                              sort.direction === 'asc' ? (
                                <ChevronUp className="size-3" />
                              ) : (
                                <ChevronDown className="size-3" />
                              )
                            ) : (
                              <ArrowUpDown className="size-3 opacity-40" />
                            )}
                          </button>
                        ) : (
                          column.header
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody>
                  {filtered.map((row) => (
                    <tr
                      key={getRowKey(row)}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                      className={cn(
                        'border-b border-border last:border-0 transition-colors',
                        onRowClick && 'cursor-pointer hover:bg-accent/50',
                      )}
                    >
                      {columns.map((column) => (
                        <td
                          key={column.key}
                          className={cn(
                            'px-4 py-3 align-middle',
                            column.align === 'right' && 'text-right',
                            column.hideOnMobile && 'hidden lg:table-cell',
                            column.className,
                          )}
                        >
                          {column.cell(row)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {/* -------------------------- Mobile cards ----------------------- */}
          <div className="space-y-2 md:hidden">
            {filtered.map((row) => {
              const primary = columns.find((c) => c.primary) ?? columns[0];
              const rest = columns.filter((c) => c !== primary);

              return (
                <Card
                  key={getRowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn('p-4', onRowClick && 'cursor-pointer active:bg-accent/50')}
                >
                  <div className="mb-2">{primary.cell(row)}</div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
                    {rest.map((column) => (
                      <div key={column.key} className="min-w-0">
                        <dt className="text-[11px] text-muted-foreground">{column.header}</dt>
                        <dd className="mt-0.5 truncate text-sm">{column.cell(row)}</dd>
                      </div>
                    ))}
                  </dl>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
