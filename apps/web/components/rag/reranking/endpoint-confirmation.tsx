'use client';
import { useTranslations } from 'next-intl';
import { useORPC } from '@/hooks/use-orpc';
import { ConfirmCatalogAction } from '../catalog-dialog';
import type { EndpointConfirmation } from './types';

/** Existing saved profile bindings are unchanged by selecting another active endpoint. */
export function RerankEndpointConfirmation({
    confirmation,
    onClose,
}: Readonly<{ confirmation: EndpointConfirmation; onClose: () => void }>) {
    const tr = useTranslations('rag.reranking.endpoints');
    const { client } = useORPC();
    const activate = confirmation.kind === 'activate';
    const input = {
        id: confirmation.item.id,
        expectedRevision: confirmation.item.revision,
    };
    return (
        <ConfirmCatalogAction
            title={tr(activate ? 'activateTitle' : 'removeTitle')}
            description={tr(
                activate ? 'activateDescription' : 'removeDescription',
                { name: confirmation.item.name }
            )}
            onClose={onClose}
            action={() =>
                activate
                    ? client.admin.rag.reranking.endpoints.activate(input)
                    : client.admin.rag.reranking.endpoints.remove(input)
            }
        />
    );
}
