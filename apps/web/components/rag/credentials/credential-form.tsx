'use client';
import { useState } from 'react';
import {
    credentialData,
    credentialUpdateData,
} from '@repo/api-contracts/v1/rag/credentials';
import { provider as credentialProvider } from '@repo/api-contracts/v1/rag/common';
import { useORPC } from '@/hooks/use-orpc';
import { Button } from '@repo/ui/button';
import { CatalogDialog } from '../catalog-dialog';
import { ActionError, useCatalogAction } from '../catalog-action';
import { TextField, SelectField, CheckField } from '../form-fields';
import { CredentialProviderFields } from './credential-provider-fields';
import { credentialFormData } from './credential-form-data';
import type { Credential } from '../types';

export function CredentialForm({
    existing,
    onClose,
}: Readonly<{ existing?: Credential; onClose: () => void }>) {
    const { client } = useORPC();
    const mutation = useCatalogAction();
    const [provider, setProvider] = useState(existing?.provider ?? 'OLLAMA');
    const current = existing?.data;
    return (
        <CatalogDialog
            title={
                existing
                    ? 'Modifier les credentials'
                    : 'Ajouter des credentials'
            }
            description='Les secrets restent masqués. Enregistrer ne teste pas la connexion au fournisseur.'
            busy={mutation.busy}
            onClose={onClose}
        >
            <form
                className='space-y-4'
                onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void mutation.run(async () => {
                        const data = credentialFormData(
                            form,
                            provider,
                            Boolean(existing)
                        );
                        const name = String(form.get('name'));
                        await (existing
                            ? client.admin.rag.credentials.update({
                                  id: existing.id,
                                  expectedRevision: existing.revision,
                                  name,
                                  data: credentialUpdateData.parse(data),
                              })
                            : client.admin.rag.credentials.create({
                                  name,
                                  data: credentialData.parse(data),
                                  activate: form.has('activate'),
                              }));
                    }, onClose);
                }}
            >
                <fieldset disabled={mutation.busy} className='space-y-4'>
                    <TextField
                        label='Nom des credentials'
                        name='name'
                        required
                        maxLength={100}
                        defaultValue={existing?.name}
                        autoComplete='off'
                    />
                    <SelectField
                        label='Fournisseur'
                        value={provider}
                        disabled={Boolean(existing)}
                        onChange={(event) => {
                            setProvider(
                                credentialProvider.parse(event.target.value)
                            );
                        }}
                    >
                        <option value='S3'>S3 compatible</option>
                        <option value='OLLAMA'>Ollama</option>
                        <option value='COHERE'>Cohere</option>
                        <option value='VOYAGE'>Voyage</option>
                    </SelectField>
                    <TextField
                        label='URL du service'
                        name='endpoint'
                        type='url'
                        required
                        maxLength={2048}
                        defaultValue={current?.endpoint}
                        placeholder='https://service.example.com'
                    />
                    <CredentialProviderFields
                        provider={provider}
                        existing={existing}
                    />
                    {existing ? (
                        <p className='text-sm text-muted-foreground'>
                            Vous pouvez renouveler les secrets. Une destination
                            utilisée par une collection ou un fichier ne peut
                            plus être modifiée : créez de nouveaux credentials.
                        </p>
                    ) : (
                        <CheckField
                            name='activate'
                            label='Utiliser pour les nouvelles configurations de cette organisation'
                            defaultChecked
                        />
                    )}
                </fieldset>
                <ActionError error={mutation.error} />
                <div className='flex justify-end gap-2'>
                    <Button
                        type='button'
                        variant='outline'
                        disabled={mutation.busy}
                        onClick={onClose}
                    >
                        Annuler
                    </Button>
                    <Button disabled={mutation.busy}>
                        {mutation.busy ? 'Enregistrement…' : 'Enregistrer'}
                    </Button>
                </div>
            </form>
        </CatalogDialog>
    );
}
