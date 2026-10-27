'use client';
import { useState, type FormEvent } from 'react';
import type { VectorixApiV1Client } from '@repo/api';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { useRerankAction } from '../reranking/rerank-action';
import type { RerankProfile, RerankedSearchResponse } from '../reranking/types';
import { filtersFromForm } from './search-filters';
import type { MetadataFields, SearchResponse, SearchResult } from './types';

type Response =
    | Readonly<{ kind: 'ordinary'; value: SearchResponse }>
    | Readonly<{ kind: 'reranked'; value: RerankedSearchResponse }>;
type RerankAccess = Readonly<{
    available: boolean;
    profile: RerankProfile | undefined;
}>;
type SearchInput = Parameters<
    VectorixApiV1Client['admin']['rag']['indexing']['search']
>[0];

function searchInput(
    data: FormData,
    collectionId: string,
    fields: MetadataFields
): SearchInput {
    const strategy = data.get('strategy');
    if (
        strategy !== 'HYBRID' &&
        strategy !== 'LEXICAL' &&
        strategy !== 'VECTOR'
    )
        throw new Error('Invalid strategy.');
    return {
        collectionId,
        query: String(data.get('query')),
        strategy,
        topK: Number(data.get('topK')),
        filters: filtersFromForm(data, fields),
    };
}

/** The legacy operation remains the default; a fresh attempt identifier represents each explicit opt-in. */
async function dispatchSearch(
    client: VectorixApiV1Client,
    input: SearchInput,
    data: FormData,
    rerank: RerankAccess
): Promise<Response> {
    if (!data.has('rerank'))
        return {
            kind: 'ordinary',
            value: await client.admin.rag.indexing.search(input),
        };
    if (!rerank.available || !rerank.profile)
        throw new Error('Reranking is unavailable.');
    return {
        kind: 'reranked',
        value: await client.admin.rag.reranking.extended.search({
            ...input,
            requestId: crypto.randomUUID(),
            expectedRerankRevision: rerank.profile.revision,
            compare: data.has('compare'),
        }),
    };
}

function currentResponse(response: Response | null, rerank: RerankAccess) {
    if (!response || response.kind === 'ordinary') return response;
    return rerank.available &&
        response.value.reranking.revision === rerank.profile?.revision
        ? response
        : null;
}

/** Retain ordinary results during optional-profile failures and fence reranked receipts by current authority. */
export function useSearchExecution({
    collectionId,
    fields,
    ready,
    rerank,
}: Readonly<{
    collectionId: string;
    fields: MetadataFields;
    ready: boolean;
    rerank: RerankAccess;
}>) {
    const { client } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const action = useRerankAction();
    const [optionsResetToken, setOptionsResetToken] = useState(0);
    const [response, setResponse] = useState<Response | null>(null);
    const [source, setSource] = useState<{
        result: SearchResult;
        rerankRevision: number | null;
    } | null>(null);
    const visibleResponse = currentResponse(response, rerank);
    const visibleSource =
        source &&
        (source.rerankRevision === null ||
            (rerank.available &&
                source.rerankRevision === rerank.profile?.revision))
            ? source.result
            : null;
    function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (
            !collectionId ||
            !ready ||
            action.busy ||
            !canOperation('admin.rag.indexing.search')
        )
            return;
        const data = new FormData(event.currentTarget);
        // Consume one explicit reranking intent before resetting only the opt-in controls.
        setOptionsResetToken((token) => token + 1);
        setResponse(null);
        setSource(null);
        void action.run(
            () =>
                dispatchSearch(
                    client,
                    searchInput(data, collectionId, fields),
                    data,
                    rerank
                ),
            setResponse
        );
    }
    function openSource(result: SearchResult) {
        setSource({
            result,
            rerankRevision:
                visibleResponse?.kind === 'reranked'
                    ? visibleResponse.value.reranking.revision
                    : null,
        });
    }
    return {
        action,
        optionsResetToken,
        response: visibleResponse,
        resultsUnavailable: Boolean(response && !visibleResponse),
        source: visibleSource,
        onSubmit,
        openSource,
        closeSource: () => setSource(null),
    };
}
