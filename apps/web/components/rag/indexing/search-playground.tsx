'use client';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { z } from 'zod';
import { searchFilters } from '@repo/api-contracts/v1/rag/indexing-types';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { AreaField, TextField, SelectField, CheckField } from '../form-fields';
import { IndexError, useIndexAction } from './index-state';
import { SearchDocumentFilter } from './search-document-filter';
import { MetadataFilters } from './metadata-filters';
import { typedMetadataValue } from './document-metadata';
import { ChunkSources } from './index-chunks';
import { SearchSource } from './search-source';
import type { MetadataFields, SearchResponse, SearchResult } from './types';

const metadataRows = z
    .array(
        z.object({
            field: z.string(),
            operator: z.enum(['EQ', 'IN', 'GTE', 'LTE']),
            value: z.string(),
        })
    )
    .max(20);
function filtersFromForm(data: FormData, fields: MetadataFields) {
    const list = (key: string) => data.getAll(key).map(String);
    const rows = metadataRows.parse(
        JSON.parse(String(data.get('metadataFilters') ?? '[]'))
    );
    const metadata = rows.map((row) => {
        const type = fields[row.field];
        if (!type) throw new Error('Invalid filter.');
        return {
            field: row.field,
            operator: row.operator,
            value:
                row.operator === 'IN'
                    ? row.value
                          .split('\n')
                          .map((value) =>
                              typedMetadataValue(value.trim(), type)
                          )
                    : typedMetadataValue(row.value.trim(), type),
        };
    });
    const documentIds = z
        .array(z.string())
        .parse(JSON.parse(String(data.get('documentIds') ?? '[]')));
    const after = String(data.get('createdAfter') ?? '');
    const before = String(data.get('createdBefore') ?? '');
    return searchFilters.parse({
        ...(documentIds.length ? { documentIds } : {}),
        ...(list('language').length ? { languages: list('language') } : {}),
        ...(list('mediaType').length ? { mediaTypes: list('mediaType') } : {}),
        ...(String(data.get('tags') ?? '').trim()
            ? {
                  tags: String(data.get('tags'))
                      .split(',')
                      .map((tag) => tag.trim())
                      .filter(Boolean),
              }
            : {}),
        ...(after ? { createdAfter: new Date(`${after}T00:00:00.000Z`) } : {}),
        ...(before
            ? { createdBefore: new Date(`${before}T23:59:59.999Z`) }
            : {}),
        ...(metadata.length ? { metadata } : {}),
    });
}
export function SearchPlayground({
    collectionId,
    fields,
    ready,
}: Readonly<{ collectionId: string; fields: MetadataFields; ready: boolean }>) {
    const tr = useTranslations('rag.indexing');
    const format = useFormatter();
    const { client } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const action = useIndexAction();
    const [response, setResponse] = useState<SearchResponse | null>(null);
    const [source, setSource] = useState<SearchResult | null>(null);
    return (
        <section className='space-y-5 rounded-xl border p-5'>
            <h3 className='font-semibold'>{tr('playground')}</h3>
            <p className='text-sm text-muted-foreground'>
                {tr('playgroundHint')}
            </p>
            {!ready && <p role='status'>{tr('searchNotReady')}</p>}
            <form
                className='space-y-4'
                onSubmit={(event) => {
                    event.preventDefault();
                    const data = new FormData(event.currentTarget);
                    setResponse(null);
                    setSource(null);
                    void action.run(
                        () => {
                            const strategy = data.get('strategy');
                            if (
                                strategy !== 'HYBRID' &&
                                strategy !== 'LEXICAL' &&
                                strategy !== 'VECTOR'
                            )
                                throw new Error('Invalid strategy.');
                            return client.admin.rag.indexing.search({
                                collectionId,
                                query: String(data.get('query')),
                                strategy,
                                topK: Number(data.get('topK')),
                                filters: filtersFromForm(data, fields),
                            });
                        },
                        setResponse,
                        false
                    );
                }}
            >
                <fieldset
                    disabled={action.busy || !ready}
                    className='space-y-4'
                >
                    <AreaField
                        label={tr('query')}
                        name='query'
                        required
                        maxLength={4000}
                        placeholder={tr('queryPlaceholder')}
                        rows={3}
                    />
                    <div className='grid gap-4 sm:grid-cols-2'>
                        <SelectField
                            label={tr('strategy')}
                            name='strategy'
                            defaultValue='HYBRID'
                        >
                            {(['HYBRID', 'LEXICAL', 'VECTOR'] as const).map(
                                (strategy) => (
                                    <option key={strategy} value={strategy}>
                                        {tr(`strategies.${strategy}`)}
                                    </option>
                                )
                            )}
                        </SelectField>
                        <TextField
                            label={tr('topK')}
                            name='topK'
                            type='number'
                            required
                            min={1}
                            max={50}
                            defaultValue={10}
                        />
                    </div>
                    <details
                        className='space-y-4 rounded-lg border p-4'
                        onInvalidCapture={(event) => {
                            event.currentTarget.open = true;
                        }}
                    >
                        <summary className='cursor-pointer font-medium'>
                            {tr('filters')}
                        </summary>
                        <fieldset className='space-y-2'>
                            <legend className='mb-2 text-sm font-medium'>
                                {tr('language')}
                            </legend>
                            <div className='flex flex-wrap gap-4'>
                                {(
                                    [
                                        'FR',
                                        'EN',
                                        'MIXED',
                                        'UNDETERMINED',
                                    ] as const
                                ).map((language) => (
                                    <CheckField
                                        key={language}
                                        name='language'
                                        value={language}
                                        label={tr(`languages.${language}`)}
                                    />
                                ))}
                            </div>
                        </fieldset>
                        <fieldset className='space-y-2'>
                            <legend className='mb-2 text-sm font-medium'>
                                {tr('fileTypes')}
                            </legend>
                            <div className='flex flex-wrap gap-4'>
                                {[
                                    ['PDF', 'application/pdf'],
                                    [
                                        'DOCX',
                                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                                    ],
                                    ['TXT', 'text/plain'],
                                    ['Markdown', 'text/markdown'],
                                ].map(([label, value]) => (
                                    <CheckField
                                        key={value}
                                        name='mediaType'
                                        value={value}
                                        label={label!}
                                    />
                                ))}
                            </div>
                        </fieldset>
                        <TextField
                            label={tr('tags')}
                            name='tags'
                            maxLength={1300}
                        />
                        <div className='grid gap-4 sm:grid-cols-2'>
                            <TextField
                                label={tr('createdAfter')}
                                name='createdAfter'
                                type='date'
                            />
                            <TextField
                                label={tr('createdBefore')}
                                name='createdBefore'
                                type='date'
                            />
                        </div>
                        <SearchDocumentFilter collectionId={collectionId} />
                        <MetadataFilters fields={fields} />
                    </details>
                </fieldset>
                <IndexError error={action.error} />
                <Button disabled={action.busy || !ready}>
                    {action.busy ? tr('searching') : tr('search')}
                </Button>
            </form>
            {response && (
                <div className='space-y-4' aria-live='polite'>
                    <p className='text-sm'>
                        {tr('searchSummary', {
                            count: response.results.length,
                            duration: format.number(response.durationMs, {
                                maximumFractionDigits: 0,
                            }),
                            strategy: tr(`strategies.${response.strategy}`),
                        })}
                    </p>
                    {response.vectorUnderfilled && (
                        <p
                            role='status'
                            className='rounded-lg border p-3 text-sm'
                        >
                            {tr('underfilled')}
                        </p>
                    )}
                    {response.results.length === 0 && <p>{tr('noResults')}</p>}
                    <ol className='space-y-4'>
                        {response.results.map((result, index) => (
                            <li
                                key={result.id}
                                className='space-y-3 rounded-lg border p-4'
                            >
                                <h4 className='break-words font-medium'>
                                    {tr('resultTitle', {
                                        rank: index + 1,
                                        name: result.documentName,
                                        version: result.version,
                                    })}
                                </h4>
                                <pre
                                    tabIndex={0}
                                    className='max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-sm'
                                >
                                    {result.text}
                                </pre>
                                <ChunkSources chunk={result} />
                                <p className='text-xs text-muted-foreground'>
                                    {tr('scores', {
                                        lexical: result.scores.lexicalRank ?? 0,
                                        vector: result.scores.vectorRank ?? 0,
                                        rrf: format.number(result.scores.rrf, {
                                            maximumFractionDigits: 5,
                                        }),
                                    })}
                                </p>
                                {canOperation(
                                    'admin.rag.indexing.sourcePreview'
                                ) && (
                                    <Button
                                        variant='outline'
                                        onClick={() => setSource(result)}
                                    >
                                        {tr('openSource')}
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ol>
                </div>
            )}
            {source && (
                <SearchSource
                    collectionId={collectionId}
                    result={source}
                    onClose={() => setSource(null)}
                />
            )}
        </section>
    );
}
