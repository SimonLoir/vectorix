'use client';
import { TextField, CheckField } from '../form-fields';
import type { Credential } from '../types';

/** Provider-specific inputs never prefill secrets returned by the masked catalog DTO. */
export function CredentialProviderFields({
    provider,
    existing,
}: Readonly<{
    provider: Credential['provider'];
    existing?: Credential;
}>) {
    const current = existing?.data;
    return provider === 'S3' ? (
        <div className='space-y-4'>
            <div className='grid gap-4 sm:grid-cols-2'>
                <TextField
                    label='Région S3'
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
                    label='Bucket privé'
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
                label='Utiliser les chemins de type path-style (RustFS)'
                name='forcePathStyle'
                defaultChecked={
                    current?.provider === 'S3' ? current.forcePathStyle : true
                }
            />
            <TextField
                label='Identifiant d’accès S3'
                name='accessKeyId'
                type='password'
                autoComplete='new-password'
                required={!existing}
                maxLength={8192}
                placeholder={existing ? 'Laisser vide pour conserver' : ''}
            />
            <TextField
                label='Secret S3'
                name='secretAccessKey'
                type='password'
                autoComplete='new-password'
                required={!existing}
                maxLength={8192}
                placeholder={existing ? 'Laisser vide pour conserver' : ''}
            />
        </div>
    ) : (
        <div className='space-y-3'>
            <TextField
                label={
                    provider === 'OLLAMA' ? 'Clé API (facultative)' : 'Clé API'
                }
                name='apiKey'
                type='password'
                autoComplete='new-password'
                required={!existing && provider !== 'OLLAMA'}
                maxLength={8192}
                placeholder={existing ? 'Laisser vide pour conserver' : ''}
            />
            {provider === 'OLLAMA' && existing && (
                <CheckField
                    label='Supprimer la clé API actuelle'
                    name='removeKey'
                />
            )}
        </div>
    );
}
