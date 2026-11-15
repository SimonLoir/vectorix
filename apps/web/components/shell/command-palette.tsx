'use client';

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useState,
    type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { useQuery } from '@tanstack/react-query';
import { Database, FileText, Monitor, Moon, Sun } from 'lucide-react';
import {
    CommandDialog,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
    CommandSeparator,
} from '@repo/ui/command';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { useVisibleNavigation } from './use-visible-navigation';

/** Minimum characters before the palette queries collections and documents. */
const REMOTE_SEARCH_MIN_LENGTH = 2;
/** Server-side page size per entity type; the palette is a jump list, not a browser. */
const REMOTE_SEARCH_LIMIT = 5;
const REMOTE_SEARCH_DEBOUNCE_MS = 200;

type CommandPaletteState = { readonly open: () => void };
const CommandPaletteContext = createContext<CommandPaletteState | null>(null);

/** Opens the dashboard command palette from shell buttons. */
export function useCommandPalette(): CommandPaletteState {
    const ctx = useContext(CommandPaletteContext);
    if (!ctx) {
        throw new Error('useCommandPalette requires CommandPaletteProvider');
    }
    return ctx;
}

/**
 * Hosts the ⌘K / Ctrl+K palette for the dashboard. Remote results come from
 * the organization-scoped, paginated list endpoints and are only requested
 * while the palette is open and the member holds the matching list operation.
 */
export function CommandPaletteProvider({
    children,
}: Readonly<{ children: ReactNode }>) {
    const [isOpen, setOpen] = useState(false);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (
                event.key.toLowerCase() === 'k' &&
                (event.metaKey || event.ctrlKey) &&
                !event.altKey
            ) {
                event.preventDefault();
                setOpen((value) => !value);
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, []);

    const open = useCallback(() => setOpen(true), []);

    return (
        <CommandPaletteContext.Provider value={{ open }}>
            {children}
            <CommandPalette open={isOpen} onOpenChange={setOpen} />
        </CommandPaletteContext.Provider>
    );
}

function useDebouncedValue(value: string, delay: number) {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(timer);
    }, [value, delay]);
    return debounced;
}

function CommandPalette({
    open,
    onOpenChange,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>) {
    const t = useTranslations('dashboard.commandPalette');
    const nav = useTranslations('dashboard.navigation');
    const appearance = useTranslations('appearance');
    const router = useRouter();
    const { setTheme } = useTheme();
    const { orpc } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const items = useVisibleNavigation();
    const [search, setSearch] = useState('');
    const term = useDebouncedValue(search.trim(), REMOTE_SEARCH_DEBOUNCE_MS);
    const remoteEnabled = open && term.length >= REMOTE_SEARCH_MIN_LENGTH;
    const input = { query: term, offset: 0, limit: REMOTE_SEARCH_LIMIT };

    const collections = useQuery({
        ...orpc.admin.rag.collections.list.queryOptions({ input }),
        enabled: remoteEnabled && canOperation('admin.rag.collections.list'),
        retry: false,
    });
    const documents = useQuery({
        ...orpc.admin.rag.documents.list.queryOptions({ input }),
        enabled: remoteEnabled && canOperation('admin.rag.documents.list'),
        retry: false,
    });

    const showCollections =
        remoteEnabled && canOperation('admin.rag.collections.list');
    const showDocuments =
        remoteEnabled && canOperation('admin.rag.documents.list');

    const handleOpenChange = (next: boolean) => {
        if (!next) setSearch('');
        onOpenChange(next);
    };
    const run = (action: () => void) => {
        handleOpenChange(false);
        action();
    };
    const remoteItems = (
        query: typeof collections | typeof documents,
        kind: 'collections' | 'documents'
    ) => {
        const Icon = kind === 'collections' ? Database : FileText;
        return (
            <CommandGroup forceMount heading={t(`groups.${kind}`)}>
                {query.isError ? (
                    <p
                        role='alert'
                        className='px-2 py-1.5 text-xs text-destructive'
                    >
                        {t('searchError')}
                    </p>
                ) : query.isPending ? (
                    <p
                        role='status'
                        className='px-2 py-1.5 text-xs text-muted-foreground'
                    >
                        {t('loading')}
                    </p>
                ) : query.data.items.length === 0 ? (
                    <p className='px-2 py-1.5 text-xs text-muted-foreground'>
                        {t('noMatches')}
                    </p>
                ) : (
                    query.data.items.map((item) => (
                        <CommandItem
                            key={item.id}
                            forceMount
                            value={`${kind}:${item.id}`}
                            onSelect={() =>
                                run(() =>
                                    router.push(`/dashboard/${kind}/${item.id}`)
                                )
                            }
                        >
                            <Icon aria-hidden='true' />
                            <span className='truncate'>{item.name}</span>
                        </CommandItem>
                    ))
                )}
            </CommandGroup>
        );
    };

    return (
        <CommandDialog
            open={open}
            onOpenChange={handleOpenChange}
            title={t('title')}
            description={t('description')}
        >
            <CommandInput
                value={search}
                onValueChange={setSearch}
                placeholder={t('placeholder')}
                aria-label={t('placeholder')}
            />
            <CommandList>
                {showCollections || showDocuments ? null : (
                    <CommandEmpty>{t('empty')}</CommandEmpty>
                )}
                <CommandGroup heading={t('groups.pages')}>
                    {items.map((item) => (
                        <CommandItem
                            key={item.href}
                            value={`page:${item.href}`}
                            keywords={[
                                nav(item.label),
                                ...(item.keywords ?? []),
                            ]}
                            onSelect={() => run(() => router.push(item.href))}
                        >
                            <item.icon aria-hidden='true' />
                            {nav(item.label)}
                        </CommandItem>
                    ))}
                </CommandGroup>
                {showCollections
                    ? remoteItems(collections, 'collections')
                    : null}
                {showDocuments ? remoteItems(documents, 'documents') : null}
                <CommandSeparator />
                <CommandGroup heading={t('groups.preferences')}>
                    {(
                        [
                            ['light', Sun],
                            ['dark', Moon],
                            ['system', Monitor],
                        ] as const
                    ).map(([theme, Icon]) => (
                        <CommandItem
                            key={theme}
                            value={`theme:${theme}`}
                            keywords={[appearance('label'), appearance(theme)]}
                            onSelect={() => run(() => setTheme(theme))}
                        >
                            <Icon aria-hidden='true' />
                            {t('theme', { theme: appearance(theme) })}
                        </CommandItem>
                    ))}
                </CommandGroup>
            </CommandList>
        </CommandDialog>
    );
}
