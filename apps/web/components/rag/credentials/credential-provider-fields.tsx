'use client';
import { useTranslations } from 'next-intl';
import { TextField, CheckField } from '../form-fields';
import type { Credential } from '../types';

/**
 * Provider-specific inputs never prefill secrets returned by the masked catalog
 * DTO. `secretRequired` marks an edit that moves the secret to a new destination.
 */
export function CredentialProviderFields({
    provider,
    existing,
    secretRequired = false,
}: Readonly<{
    provider: Credential['provider'];
    existing?: Credential;
    secretRequired?: boolean;
}>) {
    const tr = useTranslations('rag');
    const current = existing?.data;
    const required = !existing || secretRequired;
    let placeholder = '';
    if (existing)
        placeholder = secretRequired
            ? tr('credentials.reenterSecret')
            : tr('credentials.keepSecret');
    return provider === 'S3' ? (
        <div className='space-y-4'>
            <div className='grid gap-4 sm:grid-cols-2'>
                <TextField
                    label={tr('credentials.region')}
                    name='region'
                    required
                    maxLength={64}
                    defaultValue={
                        current?.provider === 'S3'
                            ? current.region
                            : 'us-east-1'
                    }
                />
                <TextField
                    label={tr('credentials.bucket')}
                    name='bucket'
                    required
                    minLength={3}
                    maxLength={63}
                    defaultValue={
                        current?.provider === 'S3' ? current.bucket : ''
                    }
                />
            </div>
            <CheckField
                label={tr('credentials.pathStyle')}
                name='forcePathStyle'
                defaultChecked={
                    current?.provider !== 'S3' || current.forcePathStyle
                }
            />
            <TextField
                label={tr('credentials.accessKey')}
                name='accessKeyId'
                type='password'
                autoComplete='new-password'
                required={required}
                maxLength={8192}
                placeholder={placeholder}
            />
            <TextField
                label={tr('credentials.secretKey')}
                name='secretAccessKey'
                type='password'
                autoComplete='new-password'
                required={required}
                maxLength={8192}
                placeholder={placeholder}
            />
        </div>
    ) : (
        <div className='space-y-3'>
            <TextField
                label={
                    provider === 'OLLAMA'
                        ? tr('credentials.optionalKey')
                        : tr('credentials.apiKey')
                }
                name='apiKey'
                type='password'
                autoComplete='new-password'
                required={existing ? secretRequired : provider !== 'OLLAMA'}
                maxLength={8192}
                placeholder={placeholder}
            />
            {provider === 'OLLAMA' && existing && (
                <CheckField
                    label={tr('credentials.removeKey')}
                    name='removeKey'
                />
            )}
        </div>
    );
}
