'use client';
import { useFormatter, useTranslations } from 'next-intl';
import type { RagOutputs } from '../types';

/** Hosted capability fingerprints must never be presented as verified model-weight digests. */
export function ModelVerification({
    result,
    revision,
}: Readonly<{ result: RagOutputs['indexing']['probe']; revision: number }>) {
    const tr = useTranslations('rag.indexing');
    const format = useFormatter();
    const hosted =
        result.identityKind === 'CAPABILITY_PROFILE' ||
        result.provider === 'COHERE';
    return (
        <section
            className='space-y-3 rounded-lg bg-muted p-4 text-sm'
            aria-label={tr('verificationRevision', { revision })}
        >
            <p className='font-medium'>
                {tr('verificationRevision', { revision })}
            </p>
            <dl className='grid gap-3 sm:grid-cols-2'>
                <div>
                    <dt>{tr('verifiedModel')}</dt>
                    <dd className='break-all font-medium'>{result.model}</dd>
                </div>
                <div>
                    <dt>{tr('verifiedDimensions')}</dt>
                    <dd>
                        {tr('dimensionChoices', {
                            current: result.dimensions,
                            choices: result.supportedDimensions
                                .map((value) => format.number(value))
                                .join(', '),
                        })}
                    </dd>
                </div>
                <div>
                    <dt>{tr('context')}</dt>
                    <dd>{tr('tokens', { count: result.contextTokens })}</dd>
                </div>
                <div>
                    <dt>{tr(hosted ? 'capabilityFingerprint' : 'digest')}</dt>
                    <dd className='break-all font-mono text-xs'>
                        {result.digest}
                    </dd>
                </div>
            </dl>
            {result.discoverySource && (
                <p className='text-xs text-muted-foreground'>
                    {tr(`discoverySources.${result.discoverySource}`)}
                </p>
            )}
            {hosted && (
                <p className='text-xs text-muted-foreground'>
                    {tr('hostedIdentityHint')}
                </p>
            )}
        </section>
    );
}
