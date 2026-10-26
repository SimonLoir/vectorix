'use client';
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { rerankFailure } from '@repo/api-contracts/v1/rag/reranking';
import { requestErrorKey } from '@repo/dashboard-core/lib/request-errors';

const rerankCodes = new Set([
    'RERANK_DISABLED',
    'RERANK_PROFILE_CHANGED',
    'RERANK_REQUEST_REPLAY',
    'RERANK_CAPACITY',
    'RERANK_DAILY_LIMIT',
    'RERANK_INPUT_INVALID',
]);

/** Display only the finite public failure codes, including compatible search failures. */
export function useRerankAction() {
    const tr = useTranslations('rag.reranking');
    const indexTr = useTranslations('rag.indexing');
    const cache = useQueryClient();
    const running = useRef(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    async function run<T>(
        action: () => Promise<T>,
        done?: (value: T) => void,
        invalidate = false
    ) {
        if (running.current) return;
        running.current = true;
        setBusy(true);
        setError(null);
        try {
            const value = await action();
            if (invalidate) await cache.invalidateQueries();
            done?.(value);
        } catch (cause) {
            const data =
                cause && typeof cause === 'object' && 'data' in cause
                    ? cause.data
                    : null;
            const parsed =
                data && typeof data === 'object' && 'errorCode' in data
                    ? rerankFailure.safeParse(data.errorCode)
                    : null;
            if (parsed?.success)
                setError(
                    rerankCodes.has(parsed.data)
                        ? tr(`errors.${parsed.data}`)
                        : indexTr(`errors.${parsed.data}`)
                );
            else
                setError(
                    requestErrorKey(cause) === 'rateLimited'
                        ? indexTr('rateLimited')
                        : tr('failed')
                );
        } finally {
            running.current = false;
            setBusy(false);
        }
    }
    return { busy, error, run };
}
