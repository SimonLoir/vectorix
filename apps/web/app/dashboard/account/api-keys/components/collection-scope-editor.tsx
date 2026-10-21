'use client';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import type { PermissionSet } from '@repo/auth/permissions';
import { useORPC } from '@/hooks/use-orpc';
import { Button } from '@repo/ui/button';
import { CheckField } from '@/components/rag/form-fields';
import {
    CatalogPagination,
    CatalogQueryState,
    CatalogSearch,
    useCatalogPagination,
} from '@/components/rag/catalog-controls';
import type { ListedApiKey } from './api-key-line';

type Scopes = ListedApiKey['collectionScopes'];
export function CollectionScopeEditor({
    value,
    onChange,
    permissions,
    readOnly,
}: Readonly<{
    value: Scopes;
    onChange: (scopes: Scopes) => void;
    permissions: PermissionSet;
    readOnly: boolean;
}>) {
    const tr = useTranslations('rag');
    const { orpc } = useORPC();
    const page = useCatalogPagination();
    const query = useQuery({
        ...orpc.admin.rag.collections.list.queryOptions({
            input: {
                query: page.query,
                offset: page.offset,
                limit: page.limit,
            },
        }),
        enabled: !readOnly,
        staleTime: 0,
    });
    function toggle(
        collectionId: string,
        action: 'read' | 'manageDocuments',
        checked: boolean
    ) {
        const current = value.find(
            (scope) => scope.collectionId === collectionId
        ) ?? { collectionId, read: false, manageDocuments: false };
        const updated = { ...current, [action]: checked };
        onChange([
            ...value.filter((scope) => scope.collectionId !== collectionId),
            ...(updated.read || updated.manageDocuments ? [updated] : []),
        ]);
    }
    return (
        <section className='space-y-3 rounded-lg border p-4'>
            <h3 className='font-medium'>{tr('keys.title')}</h3>
            <p className='text-sm text-muted-foreground'>{tr('keys.hint')}</p>
            {value.length > 0 && (
                <ul className='space-y-2'>
                    {value.map((scope) => (
                        <li
                            key={scope.collectionId}
                            className='flex items-center justify-between gap-2 text-xs'
                        >
                            <span className='break-all'>
                                {scope.collectionId} ·{' '}
                                {[
                                    scope.read && tr('common.read'),
                                    scope.manageDocuments &&
                                        tr('common.documents'),
                                ]
                                    .filter(Boolean)
                                    .join(' / ')}
                            </span>
                            {!readOnly && (
                                <Button
                                    type='button'
                                    variant='ghost'
                                    size='sm'
                                    aria-label={tr('keys.removeScope', {
                                        id: scope.collectionId,
                                    })}
                                    onClick={() =>
                                        onChange(
                                            value.filter(
                                                (item) =>
                                                    item.collectionId !==
                                                    scope.collectionId
                                            )
                                        )
                                    }
                                >
                                    {tr('common.remove')}
                                </Button>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {!readOnly && (
                <>
                    <CatalogSearch
                        value={page.query}
                        onChange={page.search}
                        label={tr('keys.search')}
                    />
                    <CatalogQueryState query={query} />
                    {!query.isError && query.data && (
                        <>
                            <div className='max-h-64 divide-y overflow-y-auto'>
                                {query.data.items.map((collection) => {
                                    const selected = value.find(
                                        (scope) =>
                                            scope.collectionId === collection.id
                                    );
                                    return (
                                        <div
                                            className='space-y-2 py-3'
                                            key={collection.id}
                                        >
                                            <p className='text-sm font-medium'>
                                                {collection.name}
                                            </p>
                                            <div className='flex flex-wrap gap-4'>
                                                {(
                                                    [
                                                        'read',
                                                        'manageDocuments',
                                                    ] as const
                                                ).map((action) => (
                                                    <CheckField
                                                        key={action}
                                                        label={
                                                            action === 'read'
                                                                ? tr(
                                                                      'common.read'
                                                                  )
                                                                : tr(
                                                                      'keys.manageDocuments'
                                                                  )
                                                        }
                                                        checked={
                                                            selected?.[
                                                                action
                                                            ] ?? false
                                                        }
                                                        disabled={
                                                            !collection
                                                                .permissions[
                                                                action
                                                            ] ||
                                                            !permissions.ragCollection?.includes(
                                                                action
                                                            ) ||
                                                            (!selected &&
                                                                value.length >=
                                                                    100)
                                                        }
                                                        onChange={(event) =>
                                                            toggle(
                                                                collection.id,
                                                                action,
                                                                event.target
                                                                    .checked
                                                            )
                                                        }
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            <CatalogPagination
                                offset={page.offset}
                                total={query.data.total}
                                onChange={page.setOffset}
                            />
                        </>
                    )}
                </>
            )}
        </section>
    );
}
