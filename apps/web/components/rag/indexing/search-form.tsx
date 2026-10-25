'use client';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Search, SlidersHorizontal } from 'lucide-react';
import { Button } from '@repo/ui/button';
import { AreaField, TextField, SelectField } from '../form-fields';
import { IndexError } from './index-state';
import { SearchFilterFields } from './search-filter-fields';
import type { MetadataFields } from './types';

type QueryDraft = Readonly<{
    query?: string;
    onQueryChange?: (query: string) => void;
}>;
type SubmitState = Readonly<{ busy: boolean; ready: boolean }>;

/** Home and collection search submit the same named controls and filter payload. */
export function SearchForm({
    collectionId,
    fields,
    busy,
    ready,
    error,
    presentation = 'panel',
    query,
    onQueryChange,
    collectionControl,
    onSubmit,
}: Readonly<{
    collectionId: string;
    fields: MetadataFields;
    error: string | null;
    presentation?: 'panel' | 'home';
    collectionControl?: ReactNode;
    onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}> &
    SubmitState &
    QueryDraft) {
    const tr = useTranslations('rag.indexing');
    const homeTr = useTranslations('rag.searchHome');
    const home = presentation === 'home';
    const [strategy, setStrategy] = useState<'HYBRID' | 'LEXICAL' | 'VECTOR'>(
        'HYBRID'
    );
    const [topK, setTopK] = useState('10');
    const count = Number(topK);
    const settings = {
        strategy,
        onStrategyChange: setStrategy,
        topK,
        onTopKChange: setTopK,
    };
    return (
        <form className='space-y-4' onSubmit={onSubmit}>
            {home ? (
                <HomeSearchBar
                    busy={busy}
                    ready={ready}
                    query={query}
                    onQueryChange={onQueryChange}
                    collectionControl={collectionControl}
                />
            ) : (
                <fieldset disabled={busy || !ready} className='space-y-4'>
                    <AreaField
                        label={tr('query')}
                        name='query'
                        required
                        maxLength={4000}
                        placeholder={tr('queryPlaceholder')}
                        rows={3}
                        value={query}
                        onChange={
                            onQueryChange
                                ? (event) => onQueryChange(event.target.value)
                                : undefined
                        }
                    />
                    <SearchStrategyFields {...settings} />
                </fieldset>
            )}
            <details
                className='group rounded-xl border bg-card p-4'
                onInvalidCapture={(event) => {
                    event.currentTarget.open = true;
                }}
            >
                <summary className='cursor-pointer list-none font-medium [&::-webkit-details-marker]:hidden'>
                    <span className='inline-flex items-center gap-2 text-sm'>
                        <SlidersHorizontal
                            className='size-4 text-primary'
                            aria-hidden
                        />
                        {home ? homeTr('options') : tr('filters')}
                        {home &&
                            Number.isInteger(count) &&
                            count >= 1 &&
                            count <= 50 && (
                                <span className='hidden text-xs font-normal text-muted-foreground sm:inline'>
                                    {homeTr('optionsSummary', {
                                        strategy: tr(`strategies.${strategy}`),
                                        count,
                                    })}
                                </span>
                            )}
                        <span
                            aria-hidden
                            className='ml-1 text-muted-foreground transition-transform group-open:rotate-180'
                        >
                            ⌄
                        </span>
                    </span>
                </summary>
                <fieldset
                    disabled={busy || (!home && !ready)}
                    className='mt-5 space-y-5'
                >
                    {home && <SearchStrategyFields {...settings} />}
                    <SearchFilterFields
                        collectionId={ready ? collectionId : ''}
                        fields={fields}
                    />
                </fieldset>
            </details>
            <IndexError error={error} />
            {!home && <SearchSubmit busy={busy} ready={ready} />}
        </form>
    );
}

function HomeSearchBar({
    busy,
    ready,
    query,
    onQueryChange,
    collectionControl,
}: Readonly<SubmitState & QueryDraft & { collectionControl?: ReactNode }>) {
    const tr = useTranslations('rag.indexing');
    return (
        <div className='rounded-2xl border border-primary/25 bg-card p-3 shadow-lg shadow-primary/5 transition-shadow focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15 sm:p-4'>
            <fieldset disabled={busy}>
                <TextField
                    label={tr('query')}
                    name='query'
                    type='search'
                    required
                    maxLength={4000}
                    placeholder={tr('queryPlaceholder')}
                    className='h-16 min-w-0 border-0 bg-transparent px-1 text-lg shadow-none focus-visible:ring-0 sm:h-20 sm:text-2xl'
                    value={query}
                    onChange={
                        onQueryChange
                            ? (event) => onQueryChange(event.target.value)
                            : undefined
                    }
                />
            </fieldset>
            <div className='mt-2 flex flex-wrap items-center justify-between gap-3 border-t pt-3'>
                <div className='min-w-0 max-w-full flex-1'>
                    {collectionControl}
                </div>
                <SearchSubmit busy={busy} ready={ready} prominent />
            </div>
        </div>
    );
}

function SearchStrategyFields({
    strategy,
    onStrategyChange,
    topK,
    onTopKChange,
}: Readonly<{
    strategy: 'HYBRID' | 'LEXICAL' | 'VECTOR';
    onStrategyChange: (value: 'HYBRID' | 'LEXICAL' | 'VECTOR') => void;
    topK: string;
    onTopKChange: (value: string) => void;
}>) {
    const tr = useTranslations('rag.indexing');
    return (
        <div className='grid gap-4 sm:grid-cols-2'>
            <SelectField
                label={tr('strategy')}
                name='strategy'
                value={strategy}
                onChange={(event) => {
                    const value = event.target.value;
                    if (
                        value === 'HYBRID' ||
                        value === 'LEXICAL' ||
                        value === 'VECTOR'
                    )
                        onStrategyChange(value);
                }}
            >
                {(['HYBRID', 'LEXICAL', 'VECTOR'] as const).map((strategy) => (
                    <option key={strategy} value={strategy}>
                        {tr(`strategies.${strategy}`)}
                    </option>
                ))}
            </SelectField>
            <TextField
                label={tr('topK')}
                name='topK'
                type='number'
                required
                min={1}
                max={50}
                value={topK}
                onChange={(event) => onTopKChange(event.target.value)}
            />
        </div>
    );
}

function SearchSubmit({
    busy,
    ready,
    prominent = false,
}: SubmitState & { readonly prominent?: boolean }) {
    const tr = useTranslations('rag.indexing');
    return (
        <Button
            type='submit'
            disabled={busy || !ready}
            size={prominent ? 'lg' : 'default'}
            className={
                prominent ? 'w-full gap-2 rounded-xl sm:w-auto' : undefined
            }
        >
            <Search className='size-4' aria-hidden />
            {busy ? tr('searching') : tr('search')}
        </Button>
    );
}
