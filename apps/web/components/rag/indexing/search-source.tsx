'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { CatalogDialog } from '../catalog-dialog';
import { TextField } from '../form-fields';
import { IndexQueryState, IndexError, useIndexAction } from './index-state';
import { sourcePosition } from './source-label';
import type { SearchResult } from './types';

/** Citation receipts preserve the exact published version and are reauthorized for every preview/download. */
export function SearchSource({
    collectionId,
    result,
    onClose,
}: Readonly<{
    collectionId: string;
    result: SearchResult;
    onClose: () => void;
}>) {
    const tr = useTranslations('rag');
    const { orpc, client } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const action = useIndexAction();
    const initial = result.sourceSpans[0]?.source.index ?? 0;
    const [sourceIndex, setSourceIndex] = useState(initial);
    const [jump, setJump] = useState(String(initial + 1));
    const [offsets, setOffsets] = useState([0]);
    const offset = offsets.at(-1)!;
    const query = useQuery({
        ...orpc.admin.rag.indexing.sourcePreview.queryOptions({
            input: {
                collectionId,
                receipt: result.source.receipt,
                sourceIndex,
                offset,
            },
        }),
        retry: false,
        staleTime: 0,
    });
    const data = query.isError ? undefined : query.data;
    const validJump =
        data &&
        Number.isInteger(Number(jump)) &&
        Number(jump) >= 1 &&
        Number(jump) <= data.totalSources;
    const label = data
        ? sourcePosition(data.source, tr)
        : tr('indexing.textSource');
    function select(index: number) {
        setSourceIndex(index);
        setJump(String(index + 1));
        setOffsets([0]);
    }
    async function download() {
        const file = await client.admin.rag.indexing.sourceOriginal({
            collectionId,
            receipt: result.source.receipt,
        });
        const url = URL.createObjectURL(file);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = file.name;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return (
        <CatalogDialog
            title={tr('indexing.sourceTitle')}
            description={tr('indexing.sourceHint', {
                name: result.documentName,
                version: result.version,
            })}
            onClose={onClose}
            busy={action.busy}
        >
            <div className='space-y-4'>
                <IndexQueryState query={query} />
                <IndexError error={action.error} />
                {data && (
                    <>
                        <p className='font-medium'>
                            {data.documentName} ·{' '}
                            {tr('indexing.version', { version: data.version })}
                        </p>
                        <p>
                            {label}
                            {data.source.heading && ` · ${data.source.heading}`}
                        </p>
                        <p className='text-sm'>
                            {tr('documents.sources.position', {
                                current: sourceIndex + 1,
                                total: data.totalSources,
                            })}
                        </p>
                        <div className='flex flex-wrap gap-2'>
                            <Button
                                type='button'
                                variant='outline'
                                disabled={sourceIndex === 0 || query.isFetching}
                                onClick={() => select(sourceIndex - 1)}
                            >
                                {tr('documents.sources.previous')}
                            </Button>
                            <Button
                                type='button'
                                variant='outline'
                                disabled={
                                    sourceIndex + 1 >= data.totalSources ||
                                    query.isFetching
                                }
                                onClick={() => select(sourceIndex + 1)}
                            >
                                {tr('documents.sources.next')}
                            </Button>
                        </div>
                        <form
                            className='flex items-end gap-2'
                            onSubmit={(event) => {
                                event.preventDefault();
                                if (validJump) select(Number(jump) - 1);
                            }}
                        >
                            <TextField
                                label={tr('documents.sources.jumpLabel')}
                                type='number'
                                min={1}
                                max={data.totalSources}
                                value={jump}
                                onChange={(event) =>
                                    setJump(event.target.value)
                                }
                            />
                            <Button disabled={!validJump || query.isFetching}>
                                {tr('documents.sources.jump')}
                            </Button>
                        </form>
                        {data.empty ? (
                            <p role='status'>{tr('indexing.emptySource')}</p>
                        ) : (
                            <pre
                                tabIndex={0}
                                aria-label={label}
                                className='max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-sm'
                            >
                                {data.text}
                            </pre>
                        )}
                        <p className='text-xs'>
                            {tr('documents.characters', {
                                from: data.text.length ? offset + 1 : 0,
                                to: offset + data.text.length,
                                total: data.totalCharacters,
                            })}
                        </p>
                        <div className='flex flex-wrap gap-2'>
                            <Button
                                variant='outline'
                                disabled={offset === 0 || query.isFetching}
                                onClick={() =>
                                    setOffsets((previous) =>
                                        previous.slice(0, -1)
                                    )
                                }
                            >
                                {tr('documents.sources.previousText')}
                            </Button>
                            <Button
                                variant='outline'
                                disabled={
                                    data.nextOffset === null || query.isFetching
                                }
                                onClick={() => {
                                    if (data.nextOffset !== null)
                                        setOffsets((previous) => [
                                            ...previous,
                                            data.nextOffset!,
                                        ]);
                                }}
                            >
                                {tr('documents.sources.nextText')}
                            </Button>
                        </div>
                    </>
                )}
                {canOperation('admin.rag.indexing.sourceOriginal') && (
                    <Button
                        variant='outline'
                        disabled={action.busy || query.isError}
                        onClick={() =>
                            void action.run(download, undefined, false)
                        }
                    >
                        {tr('indexing.downloadSource')}
                    </Button>
                )}
            </div>
        </CatalogDialog>
    );
}
