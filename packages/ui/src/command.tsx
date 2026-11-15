'use client';

import * as React from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import { SearchIcon } from 'lucide-react';

import { cn } from './utils';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from './dialog';

/**
 * Case- and accent-insensitive substring match over an item's keywords
 * (or its value when it has none). cmdk's default fuzzy scorer surfaces too many unrelated pages for
 * short queries such as "acc".
 */
function substringFilter(
    value: string,
    search: string,
    keywords?: string[]
): number {
    const normalize = (text: string) =>
        text
            .normalize('NFD')
            .replaceAll(/\p{Diacritic}/gu, '')
            .toLowerCase();
    const needle = normalize(search.trim());
    if (!needle) return 1;
    // Keywords carry the visible label; values are often opaque identifiers.
    const haystack = normalize(
        keywords && keywords.length > 0 ? keywords.join(' ') : value
    );
    return haystack.includes(needle) ? 1 : 0;
}

function Command({
    className,
    ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
    return (
        <CommandPrimitive
            data-slot='command'
            filter={substringFilter}
            className={cn(
                'flex h-full w-full flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground',
                className
            )}
            {...props}
        />
    );
}

/**
 * Viewport-bounded command palette dialog. The title and description are
 * visually hidden but remain available to assistive technology.
 */
function CommandDialog({
    title,
    description,
    children,
    className,
    ...props
}: React.ComponentProps<typeof Dialog> & {
    readonly title: string;
    readonly description: string;
    readonly className?: string;
}) {
    return (
        <Dialog {...props}>
            <DialogHeader className='sr-only'>
                <DialogTitle>{title}</DialogTitle>
                <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            <DialogContent
                className={cn(
                    'top-[12vh] translate-y-0 overflow-hidden p-0 sm:max-w-xl',
                    className
                )}
                showCloseButton={false}
            >
                <Command className='[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-item]_svg]:size-4'>
                    {children}
                </Command>
            </DialogContent>
        </Dialog>
    );
}

function CommandInput({
    className,
    ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
    return (
        <div
            data-slot='command-input-wrapper'
            className='flex h-12 items-center gap-2 border-b px-3'
        >
            <SearchIcon
                aria-hidden='true'
                className='size-4 shrink-0 text-muted-foreground'
            />
            <CommandPrimitive.Input
                data-slot='command-input'
                className={cn(
                    'flex h-10 w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
                    className
                )}
                {...props}
            />
        </div>
    );
}

function CommandList({
    className,
    ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
    return (
        <CommandPrimitive.List
            data-slot='command-list'
            className={cn(
                'max-h-[min(60vh,420px)] scroll-py-1 overflow-y-auto overflow-x-hidden p-1',
                className
            )}
            {...props}
        />
    );
}

function CommandEmpty({
    ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
    return (
        <CommandPrimitive.Empty
            data-slot='command-empty'
            className='py-8 text-center text-sm text-muted-foreground'
            {...props}
        />
    );
}

function CommandLoading({
    className,
    ...props
}: React.ComponentProps<typeof CommandPrimitive.Loading>) {
    return (
        <CommandPrimitive.Loading
            data-slot='command-loading'
            className={cn('px-3 py-2 text-xs text-muted-foreground', className)}
            {...props}
        />
    );
}

function CommandGroup({
    className,
    ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
    return (
        <CommandPrimitive.Group
            data-slot='command-group'
            className={cn('overflow-hidden p-1 text-foreground', className)}
            {...props}
        />
    );
}

function CommandSeparator({
    className,
    ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
    return (
        <CommandPrimitive.Separator
            data-slot='command-separator'
            className={cn('-mx-1 h-px bg-border', className)}
            {...props}
        />
    );
}

function CommandItem({
    className,
    ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
    return (
        <CommandPrimitive.Item
            data-slot='command-item'
            className={cn(
                "relative flex cursor-default select-none items-center gap-2.5 rounded-md px-2 py-2 text-sm outline-hidden data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0",
                className
            )}
            {...props}
        />
    );
}

function CommandShortcut({
    className,
    ...props
}: React.ComponentProps<'span'>) {
    return (
        <span
            data-slot='command-shortcut'
            className={cn(
                'ml-auto text-xs tracking-widest text-muted-foreground',
                className
            )}
            {...props}
        />
    );
}

export {
    Command,
    CommandDialog,
    CommandInput,
    CommandList,
    CommandEmpty,
    CommandLoading,
    CommandGroup,
    CommandItem,
    CommandShortcut,
    CommandSeparator,
};
