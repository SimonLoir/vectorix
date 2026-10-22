'use client';

import { useTranslations } from 'next-intl';
import { useDeferredValue, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { Button } from '@repo/ui/button';
import { Input } from '@repo/ui/input';
import { useORPC } from '@/hooks/use-orpc';
import { LoadingState } from './loading-state';
import { UserDirectoryTable } from './user-directory-table';

type AccessFilter = 'all' | 'superadmin' | 'standard';
const filterKeys = {
    all: 'users.all',
    superadmin: 'users.superadmins',
    standard: 'common.noAccess',
};

/** Paged global account search; changing a filter always starts again at the first page. */
export function UserList() {
    const t = useTranslations('admin.secondary');
    const { orpc } = useORPC();
    const [search, setSearch] = useState('');
    const [access, setAccess] = useState<AccessFilter>('all');
    const [page, setPage] = useState(1);
    const deferredSearch = useDeferredValue(search.trim());
    const limit = 25;
    const query = useQuery(
        orpc.superadmin.users.list.queryOptions({
            input: {
                page,
                limit,
                search: deferredSearch || undefined,
                access: access === 'all' ? undefined : access,
            },
        })
    );
    const pageCount = Math.max(1, Math.ceil((query.data?.total ?? 0) / limit));

    return (
        <div className='space-y-5'>
            <div className='admin-panel flex flex-col gap-4 p-3 xl:flex-row xl:items-center xl:justify-between'>
                <div
                    className='flex flex-wrap gap-1 rounded-xl bg-black/20 p-1'
                    aria-label={t('users.filter')}
                >
                    {(['all', 'superadmin', 'standard'] as const).map(
                        (value) => (
                            <button
                                key={value}
                                type='button'
                                aria-pressed={access === value}
                                className={`rounded-lg px-3.5 py-2 text-xs font-medium transition-colors ${access === value ? 'bg-white/10 text-cyan-200' : 'text-slate-500 hover:text-slate-200'}`}
                                onClick={() => {
                                    setAccess(value);
                                    setPage(1);
                                }}
                            >
                                {t(filterKeys[value])}
                            </button>
                        )
                    )}
                </div>
                <div className='relative w-full xl:w-96'>
                    <Search className='absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400' />
                    <Input
                        aria-label={t('users.searchLabel')}
                        placeholder={t('users.search')}
                        className='admin-field border-0 bg-black/20 pl-10'
                        value={search}
                        onChange={(event) => {
                            setSearch(event.target.value);
                            setPage(1);
                        }}
                    />
                </div>
            </div>
            <section className='admin-panel overflow-hidden'>
                {query.isPending ? (
                    <LoadingState label={t('users.loading')} />
                ) : query.isError ? (
                    <div role='alert' className='space-y-3 p-6'>
                        <p className='text-sm text-destructive'>
                            {t('common.loadError')}
                        </p>
                        <Button
                            variant='outline'
                            disabled={query.isFetching}
                            onClick={() => void query.refetch()}
                        >
                            {t('common.retry')}
                        </Button>
                    </div>
                ) : (
                    <UserDirectoryTable users={query.data.users} />
                )}
            </section>
            <div className='flex flex-wrap items-center justify-between gap-3 text-sm text-slate-400'>
                <span>
                    {t('users.total', { count: query.data?.total ?? 0 })}
                </span>
                <div className='flex items-center gap-2'>
                    <Button
                        size='sm'
                        variant='outline'
                        disabled={page <= 1 || query.isFetching}
                        onClick={() => setPage((current) => current - 1)}
                    >
                        {t('common.previous')}
                    </Button>
                    <span className='px-2 text-xs'>
                        {t('common.page', { page, total: pageCount })}
                    </span>
                    <Button
                        size='sm'
                        variant='outline'
                        disabled={
                            page >= pageCount ||
                            query.isFetching ||
                            query.isError
                        }
                        onClick={() => setPage((current) => current + 1)}
                    >
                        {t('common.next')}
                    </Button>
                </div>
            </div>
        </div>
    );
}
