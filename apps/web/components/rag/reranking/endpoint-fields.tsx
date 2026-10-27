'use client';
import { useTranslations } from 'next-intl';
import { CheckField, SelectField, TextField } from '../form-fields';
import type { RerankEndpoint } from './types';

export function RerankEndpointFields({
    existing,
    busy,
    secretRequired,
}: Readonly<{
    existing?: RerankEndpoint;
    busy: boolean;
    secretRequired: boolean;
}>) {
    const tr = useTranslations('rag.reranking.endpoints');
    const rag = useTranslations('rag');
    return (
        <fieldset disabled={busy} className='space-y-4'>
            <TextField
                label={rag('credentials.name')}
                name='name'
                required
                maxLength={100}
                defaultValue={existing?.name}
                autoComplete='off'
            />
            <SelectField
                label={rag('profile.providerLabel')}
                value={existing?.provider ?? 'TEI'}
                disabled
            >
                <option value={existing?.provider ?? 'TEI'}>
                    {existing && existing.provider !== 'TEI'
                        ? existing.provider
                        : tr('provider')}
                </option>
            </SelectField>
            <TextField
                label={rag('credentials.endpoint')}
                name='endpoint'
                type='url'
                required
                maxLength={2048}
                defaultValue={existing?.endpoint}
                autoComplete='off'
            />
            <p className='text-xs text-muted-foreground'>
                {tr('endpointHint')}
            </p>
            <TextField
                label={rag('credentials.optionalKey')}
                name='apiKey'
                type='password'
                autoComplete='new-password'
                required={secretRequired}
                maxLength={8192}
                placeholder={
                    existing
                        ? rag(
                              secretRequired
                                  ? 'credentials.reenterSecret'
                                  : 'credentials.keepSecret'
                          )
                        : undefined
                }
            />
            {existing && (
                <CheckField
                    label={rag('credentials.removeKey')}
                    name='removeKey'
                />
            )}
            {secretRequired && (
                <p role='status' className='rounded-lg border p-3 text-sm'>
                    {rag('credentials.destinationSecretHint')}
                </p>
            )}
            {!existing && (
                <CheckField
                    label={rag('credentials.activate')}
                    name='activate'
                    defaultChecked
                />
            )}
            <p className='text-xs text-muted-foreground'>{tr('saveHint')}</p>
        </fieldset>
    );
}
