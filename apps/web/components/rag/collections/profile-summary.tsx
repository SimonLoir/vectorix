import type { Collection } from '../types';
const strategies = {
    DOCUMENT_STRUCTURE: 'Structure du document',
    TOKEN_WINDOW: 'Fenêtre de tokens',
    SEMANTIC: 'Similarité sémantique',
};
export function ProfileSummary({
    configuration: c,
}: Readonly<{ configuration: Collection['configuration'] }>) {
    return (
        <div className='space-y-4 text-sm'>
            <dl className='grid gap-4 sm:grid-cols-2'>
                {Object.entries({
                    Fournisseur: c.provider,
                    Modèle: c.model,
                    Dimensions: c.dimensions,
                    Index: `${c.indexType} · ${c.metric} · ${c.numericType}`,
                    Découpage: strategies[c.chunkingStrategy],
                    'Passages enfants / contexte parent': c.parentChild
                        ? 'Activé'
                        : 'Désactivé',
                    'Taille cible / chevauchement': `${c.chunking.targetTokens} / ${c.chunking.overlapTokens} tokens`,
                    'Bornes minimum / maximum': `${c.chunking.minTokens} / ${c.chunking.maxTokens} tokens`,
                    'Seuil sémantique': `${c.chunking.semanticPercentile}e percentile`,
                    'Parent maximum': `${c.chunking.parentMaxTokens} tokens`,
                }).map(([label, value]) => (
                    <div key={label}>
                        <dt className='text-muted-foreground'>{label}</dt>
                        <dd className='mt-1 font-medium break-words'>
                            {value}
                        </dd>
                    </div>
                ))}
                <div className='sm:col-span-2'>
                    <dt className='text-muted-foreground'>
                        Liaison des credentials
                    </dt>
                    <dd className='mt-1 break-all'>
                        {c.credentialId
                            ? `Organisation · ${c.credentialId} · révision enregistrée ${c.credentialRevision}`
                            : 'Configuration de la plateforme'}
                    </dd>
                </div>
                <div className='sm:col-span-2'>
                    <dt className='text-muted-foreground'>
                        Destination vectorielle
                    </dt>
                    <dd className='mt-1 break-all'>
                        PostgreSQL de la plateforme · {c.vectorConnectionId}
                    </dd>
                </div>
            </dl>
            {c.preparation && (
                <div>
                    <h3 className='text-muted-foreground'>
                        Préparation du texte
                    </h3>
                    <p className='mt-1 whitespace-pre-wrap break-words'>
                        {c.preparation}
                    </p>
                </div>
            )}
        </div>
    );
}
