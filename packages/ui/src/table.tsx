'use client';

import * as React from 'react';

import { cn } from './utils';

type TableProps = React.ComponentProps<'table'> & {
    readonly responsive?: boolean;
};

type ResponsiveHeader = Readonly<{
    label: string;
    isSelection: boolean;
}>;

function clearGeneratedLabels(table: HTMLTableElement) {
    const generatedCells = table.querySelectorAll<HTMLElement>(
        '[data-table-label-source="generated"]'
    );

    for (const cell of generatedCells) {
        delete cell.dataset.label;
        delete cell.dataset.tableLabelSource;
        delete cell.dataset.tablePrimary;
        delete cell.dataset.tableActions;
    }
}

function getResponsiveHeaders(table: HTMLTableElement): ResponsiveHeader[] {
    const headerRow = table.tHead?.rows.item(
        (table.tHead?.rows.length ?? 1) - 1
    );
    if (!headerRow) return [];

    return Array.from(headerRow.cells).map((header) => {
        const ariaLabel = header.getAttribute('aria-label')?.trim();
        const textLabel = header.textContent?.trim();

        return {
            label: ariaLabel?.length ? ariaLabel : (textLabel ?? ''),
            isSelection: Boolean(
                header.querySelector(
                    '[role="checkbox"], input[type="checkbox"]'
                )
            ),
        };
    });
}

function enhanceResponsiveRow(
    row: HTMLTableRowElement,
    headers: ResponsiveHeader[],
    primaryColumnIndex: number
) {
    const cells = Array.from(row.cells);

    for (const cell of cells) {
        if (
            cell.dataset.label === undefined ||
            cell.dataset.tableLabelSource === 'generated'
        ) {
            cell.dataset.label = headers[cell.cellIndex]?.label ?? '';
            cell.dataset.tableLabelSource = 'generated';
        }

        if (cell.cellIndex === primaryColumnIndex) {
            cell.dataset.tablePrimary = '';
        } else {
            delete cell.dataset.tablePrimary;
        }

        const isActionCell =
            cell === cells.at(-1) &&
            Boolean(
                cell.querySelector('button, a[role="button"], [role="button"]')
            );
        if (isActionCell) {
            cell.dataset.tableActions = '';
        } else {
            delete cell.dataset.tableActions;
        }
    }
}

function enhanceResponsiveTable(table: HTMLTableElement, responsive: boolean) {
    if (!responsive) {
        clearGeneratedLabels(table);
        return;
    }

    const headers = getResponsiveHeaders(table);
    if (headers.length === 0) return;

    const primaryColumnIndex = headers.findIndex(
        (header) => header.label.length > 0 && !header.isSelection
    );

    for (const body of Array.from(table.tBodies)) {
        for (const row of Array.from(body.rows)) {
            enhanceResponsiveRow(row, headers, primaryColumnIndex);
        }
    }
}

/**
 * Renders tabular data and derives mobile card labels from its column headers.
 * Set `responsive={false}` only for tables whose structure cannot be represented
 * as one card per body row.
 */
function Table({
    className,
    responsive = true,
    children,
    ...props
}: TableProps) {
    const containerRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        const table =
            containerRef.current?.querySelector<HTMLTableElement>(
                ':scope > table'
            );
        if (!table) return;
        enhanceResponsiveTable(table, responsive);
    }, [children, responsive]);

    return (
        <div
            ref={containerRef}
            data-slot='table-container'
            data-responsive-table={responsive}
            className='relative w-full touch-pan-x overflow-x-auto overscroll-x-contain [scrollbar-width:thin]'
        >
            <table
                data-slot='table'
                className={cn('min-w-full caption-bottom text-sm', className)}
                {...props}
            >
                {children}
            </table>
        </div>
    );
}

function TableHeader({ className, ...props }: React.ComponentProps<'thead'>) {
    return (
        <thead
            data-slot='table-header'
            className={cn('[&_tr]:border-b', className)}
            {...props}
        />
    );
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
    return (
        <tbody
            data-slot='table-body'
            className={cn('[&_tr:last-child]:border-0', className)}
            {...props}
        />
    );
}

function TableFooter({ className, ...props }: React.ComponentProps<'tfoot'>) {
    return (
        <tfoot
            data-slot='table-footer'
            className={cn(
                'bg-muted/50 border-t font-medium [&>tr]:last:border-b-0',
                className
            )}
            {...props}
        />
    );
}

function TableRow({ className, ...props }: React.ComponentProps<'tr'>) {
    return (
        <tr
            data-slot='table-row'
            className={cn(
                'hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors',
                className
            )}
            {...props}
        />
    );
}

function TableHead({ className, ...props }: React.ComponentProps<'th'>) {
    return (
        <th
            data-slot='table-head'
            className={cn(
                'text-foreground h-11 px-3 text-left align-middle font-medium whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
                className
            )}
            {...props}
        />
    );
}

function TableCell({ className, ...props }: React.ComponentProps<'td'>) {
    return (
        <td
            data-slot='table-cell'
            className={cn(
                'px-3 py-3 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]',
                className
            )}
            {...props}
        />
    );
}

function TableCaption({
    className,
    ...props
}: React.ComponentProps<'caption'>) {
    return (
        <caption
            data-slot='table-caption'
            className={cn('text-muted-foreground mt-4 text-sm', className)}
            {...props}
        />
    );
}

export {
    Table,
    TableHeader,
    TableBody,
    TableFooter,
    TableHead,
    TableRow,
    TableCell,
    TableCaption,
};
