'use client';
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@repo/ui/button';
import { Input } from '@repo/ui/input';
import { Label } from '@repo/ui/label';
import { useORPC } from '@/hooks/use-orpc';
import { DocumentQueryState } from './query-state';

/** Navigate bounded source previews without treating DOCX paragraphs as physical pages. */
export function DocumentSources({
    id,
    expectedVersion,
    onRefresh,
}: Readonly<{
    id: string;
    expectedVersion: number;
    onRefresh: () => void;
}>) {
    const tr = useTranslations('rag');
    const { orpc } = useORPC();
    const jumpId = useId();
    const [sourceIndex, setSourceIndex] = useState(0);
    const [jump, setJump] = useState('1');
    const [offsets, setOffsets] = useState([0]);
    const offset = offsets.at(-1)!;
    const options = orpc.admin.rag.documents.sourcePreview.queryOptions({
        input: { id, sourceIndex, offset },
    });
    const query = useQuery({
        ...options,
        queryKey: [...options.queryKey, { expectedVersion }],
        retry: false,
        staleTime: 0,
        placeholderData: (previous) => previous,
    });
    const changedVersion = Boolean(
        query.data && query.data.version !== expectedVersion
    );
    const data =
        query.isError || query.isPlaceholderData || changedVersion
            ? undefined
            : query.data;
    const totalSources =
        query.isError || changedVersion ? 0 : (query.data?.totalSources ?? 0);
    const validJump =
        jump.trim() !== '' &&
        Number.isInteger(Number(jump)) &&
        Number(jump) >= 1 &&
        Number(jump) <= totalSources;
    const source = data?.source;
    function labelSource() {
        if (source?.kind === 'pdf-page' && source.page !== undefined)
            return tr('documents.sources.pdfPage', { page: source.page });
        if (
            source?.kind === 'docx-paragraph' &&
            source.paragraph !== undefined
        ) {
            if (
                source.part &&
                source.part !== 'body' &&
                source.partIndex !== undefined
            )
                return tr(`documents.sources.parts.${source.part}`, {
                    part: source.partIndex,
                    paragraph: source.paragraph,
                });
            if (source.section === undefined)
                return tr('documents.sources.docxParagraph', {
                    paragraph: source.paragraph,
                });
            return tr('documents.sources.docxSectionParagraph', {
                section: source.section,
                paragraph: source.paragraph,
            });
        }
        return tr('documents.sources.position', {
            current: sourceIndex + 1,
            total: totalSources,
        });
    }
    const sourceLabel = labelSource();
    function selectSource(index: number) {
        setSourceIndex(index);
        setJump(String(index + 1));
        setOffsets([0]);
    }
    return (
        <section className='space-y-4 rounded-xl border p-5'>
            <h2 className='text-lg font-semibold'>
                {tr('documents.sources.title')}
            </h2>
            <p className='text-sm text-muted-foreground'>
                {tr('documents.sources.hint')}
            </p>
            {totalSources > 0 && (
                <nav
                    aria-label={tr('documents.sources.navigation')}
                    className='space-y-3'
                >
                    <p role='status' className='text-sm'>
                        {tr('documents.sources.position', {
                            current: sourceIndex + 1,
                            total: totalSources,
                        })}
                    </p>
                    <div className='flex flex-wrap gap-2'>
                        <Button
                            variant='outline'
                            disabled={sourceIndex === 0 || query.isFetching}
                            onClick={() => selectSource(sourceIndex - 1)}
                        >
                            {tr('documents.sources.previous')}
                        </Button>
                        <Button
                            variant='outline'
                            disabled={
                                sourceIndex + 1 >= totalSources ||
                                query.isFetching
                            }
                            onClick={() => selectSource(sourceIndex + 1)}
                        >
                            {tr('documents.sources.next')}
                        </Button>
                    </div>
                    <form
                        className='flex flex-wrap items-end gap-2'
                        onSubmit={(event) => {
                            event.preventDefault();
                            if (validJump) selectSource(Number(jump) - 1);
                        }}
                    >
                        <div className='space-y-2'>
                            <Label htmlFor={jumpId}>
                                {tr('documents.sources.jumpLabel')}
                            </Label>
                            <Input
                                id={jumpId}
                                type='number'
                                inputMode='numeric'
                                min={1}
                                max={totalSources}
                                step={1}
                                required
                                className='w-32'
                                value={jump}
                                disabled={query.isFetching}
                                aria-invalid={!validJump}
                                aria-describedby={`${jumpId}-hint`}
                                onChange={(event) =>
                                    setJump(event.target.value)
                                }
                            />
                        </div>
                        <Button disabled={!validJump || query.isFetching}>
                            {tr('documents.sources.jump')}
                        </Button>
                        <p
                            id={`${jumpId}-hint`}
                            className='w-full text-sm text-muted-foreground'
                        >
                            {tr('documents.sources.jumpHint', {
                                total: totalSources,
                            })}
                        </p>
                    </form>
                </nav>
            )}
            <DocumentQueryState
                query={{
                    isError: query.isError,
                    isPending: query.isPending || query.isPlaceholderData,
                    refetch: query.refetch,
                }}
            />
            {changedVersion && !query.isError && (
                <div role='status' className='space-y-3 rounded-lg border p-4'>
                    <p>{tr('documents.sources.changedVersion')}</p>
                    <Button variant='outline' onClick={onRefresh}>
                        {tr('common.retry')}
                    </Button>
                </div>
            )}
            {data && (
                <>
                    <h3 className='font-medium'>{sourceLabel}</h3>
                    {source?.heading && (
                        <p className='break-words text-sm text-muted-foreground'>
                            {tr('documents.sources.heading', {
                                heading: source.heading,
                            })}
                        </p>
                    )}
                    {data.warnings.length > 0 && (
                        <p role='status' className='text-sm'>
                            {tr('documents.sources.warnings', {
                                count: data.warnings.length,
                            })}
                        </p>
                    )}
                    {(data.totalCharacters === 0 ||
                        data.warnings.some(
                            (warning) => warning.sourceIndex === sourceIndex
                        )) && (
                        <p
                            role='alert'
                            className='rounded-lg border p-4 text-sm'
                        >
                            {tr(
                                data.format === 'PDF'
                                    ? 'documents.sources.emptyPage'
                                    : 'documents.sources.emptyParagraph'
                            )}
                        </p>
                    )}
                    {data.text && (
                        <pre
                            className='max-h-[50dvh] overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-sm'
                            tabIndex={0}
                            aria-label={sourceLabel}
                        >
                            {data.text}
                        </pre>
                    )}
                    <p className='text-sm'>
                        {tr('documents.characters', {
                            from: data.text.length ? offset + 1 : 0,
                            to: offset + data.text.length,
                            total: data.totalCharacters,
                        })}
                    </p>
                </>
            )}
            <nav
                aria-label={tr('documents.sources.textNavigation')}
                className='flex flex-wrap gap-2'
            >
                <Button
                    variant='outline'
                    disabled={offset === 0 || query.isFetching}
                    onClick={() =>
                        setOffsets((previous) => previous.slice(0, -1))
                    }
                >
                    {tr('documents.sources.previousText')}
                </Button>
                <Button
                    variant='outline'
                    disabled={
                        !data || data.nextOffset === null || query.isFetching
                    }
                    onClick={() => {
                        const next = data?.nextOffset;
                        if (next !== null && next !== undefined)
                            setOffsets((previous) => [...previous, next]);
                    }}
                >
                    {tr('documents.sources.nextText')}
                </Button>
            </nav>
        </section>
    );
}
