'use client';
import { useState } from 'react';
import { TextField, SelectField, CheckField, AreaField } from '../form-fields';
import type { Collection } from '../types';

export function ProfileFields({
    configuration,
}: Readonly<{ configuration?: Collection['configuration'] }>) {
    const [strategy, setStrategy] = useState(
        configuration?.chunkingStrategy ?? 'DOCUMENT_STRUCTURE'
    );
    const [parent, setParent] = useState(configuration?.parentChild ?? false);
    return (
        <div className='space-y-5'>
            <div className='grid gap-4 sm:grid-cols-2'>
                <SelectField
                    label='Fournisseur d’embeddings'
                    name='provider'
                    defaultValue={configuration?.provider ?? 'OLLAMA'}
                >
                    <option value='OLLAMA'>Ollama</option>
                    <option value='COHERE'>Cohere</option>
                    <option value='VOYAGE'>Voyage</option>
                </SelectField>
                <TextField
                    label='Modèle'
                    name='model'
                    required
                    maxLength={200}
                    defaultValue={configuration?.model}
                    placeholder='Nom du modèle déployé'
                />
            </div>
            <div className='grid gap-4 sm:grid-cols-2'>
                <TextField
                    label='Dimensions des vecteurs'
                    name='dimensions'
                    type='number'
                    required
                    min={1}
                    max={16_000}
                    defaultValue={configuration?.dimensions}
                />
                <SelectField
                    label='Index vectoriel'
                    name='indexType'
                    defaultValue={configuration?.indexType ?? 'DISKANN'}
                >
                    <option value='DISKANN'>DiskANN · pgvectorscale</option>
                    <option value='HNSW'>HNSW · pgvector</option>
                </SelectField>
            </div>
            <p className='text-sm text-muted-foreground'>
                PostgreSQL de la plateforme · Similarité cosinus · Float32. HNSW
                accepte au maximum 2 000 dimensions. La compatibilité du modèle
                sera vérifiée lors de l’indexation.
            </p>
            <AreaField
                label='Instructions de préparation du texte'
                name='preparation'
                maxLength={4000}
                defaultValue={configuration?.preparation ?? ''}
                rows={3}
            />
            <SelectField
                label='Technique de découpage'
                name='chunkingStrategy'
                value={strategy}
                onChange={(event) => {
                    const value = event.target.value;
                    if (
                        value === 'TOKEN_WINDOW' ||
                        value === 'DOCUMENT_STRUCTURE' ||
                        value === 'SEMANTIC'
                    )
                        setStrategy(value);
                }}
            >
                <option value='DOCUMENT_STRUCTURE'>
                    Structure du document
                </option>
                <option value='TOKEN_WINDOW'>Fenêtre de tokens</option>
                <option value='SEMANTIC'>Similarité sémantique</option>
            </SelectField>
            <div className='grid gap-4 sm:grid-cols-2'>
                <TextField
                    label='Taille cible (tokens)'
                    name='targetTokens'
                    type='number'
                    required
                    min={32}
                    max={8192}
                    defaultValue={configuration?.chunking.targetTokens ?? 512}
                />
                <TextField
                    label='Chevauchement (tokens)'
                    name='overlapTokens'
                    type='number'
                    required
                    min={0}
                    max={4096}
                    defaultValue={configuration?.chunking.overlapTokens ?? 64}
                />
                <TextField
                    label='Taille minimale (tokens)'
                    name='minTokens'
                    type='number'
                    required
                    min={1}
                    max={8192}
                    defaultValue={configuration?.chunking.minTokens ?? 128}
                />
                <TextField
                    label='Taille maximale (tokens)'
                    name='maxTokens'
                    type='number'
                    required
                    min={32}
                    max={16_384}
                    defaultValue={configuration?.chunking.maxTokens ?? 768}
                />
            </div>
            <TextField
                label='Seuil sémantique (percentile)'
                name='semanticPercentile'
                type='number'
                required
                min={1}
                max={99}
                defaultValue={configuration?.chunking.semanticPercentile ?? 90}
                readOnly={strategy !== 'SEMANTIC'}
            />
            <CheckField
                label='Rechercher dans les passages enfants et restituer le contexte parent'
                name='parentChild'
                checked={parent}
                onChange={(event) => setParent(event.target.checked)}
            />
            <TextField
                label='Taille maximale du parent (tokens)'
                name='parentMaxTokens'
                type='number'
                required
                min={32}
                max={32_768}
                readOnly={!parent}
                defaultValue={configuration?.chunking.parentMaxTokens ?? 2048}
            />
        </div>
    );
}
