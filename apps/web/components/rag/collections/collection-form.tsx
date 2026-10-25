'use client';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { collectionProfile } from '@repo/api-contracts/v1/rag/collections';
import { useORPC } from '@/hooks/use-orpc';
import { CatalogDialog } from '../catalog-dialog';
import { useIndexAction } from '../indexing/index-state';
import type { ProfileSection } from './profile-fields';
import { ProfileResetDialog } from './profile-reset-dialog';
import {
    CollectionEditorDetails,
    CollectionEditorFooter,
    CollectionEditorSteps,
    editorStepTitles,
} from './collection-editor-chrome';
import {
    CollectionEditorProfile,
    CollectionEditorReview,
} from './collection-editor-profile';
import {
    createProfileDraft,
    effectiveProfileDraft,
    recommendedDraft,
    profileDifferences,
    profileFromDraft,
    validateProfileDraft,
    type ProfileDraft,
    type Provider,
} from './profile-draft';
import type { Collection } from '../types';

type ClientError =
    | 'name'
    | 'description'
    | 'metadata'
    | 'dimensions'
    | 'hnsw'
    | 'preset'
    | 'chunking'
    | 'invalid'
    | 'unsupportedSimple';

/** A persistent controlled draft separates navigation from the one real catalog mutation. */
export function CollectionForm({
    existing,
    profileLocked = false,
    onClose,
}: Readonly<{
    existing?: Collection;
    profileLocked?: boolean;
    onClose: () => void;
}>) {
    const tr = useTranslations('rag');
    const { client } = useORPC();
    const router = useRouter();
    const mutation = useIndexAction();
    const [name, setName] = useState(existing?.name ?? '');
    const [description, setDescription] = useState(existing?.description ?? '');
    const [grantRead, setGrantRead] = useState(true);
    const [draft, setDraft] = useState(() =>
        createProfileDraft(existing?.configuration)
    );
    const [advanced, setAdvanced] = useState(() =>
        Boolean(
            existing &&
            profileDifferences(createProfileDraft(existing.configuration))
                .length
        )
    );
    const [step, setStep] = useState(0);
    const [section, setSection] = useState<ProfileSection>('embedding');
    const [error, setError] = useState<ClientError | null>(null);
    const [pending, setPending] = useState<{
        draft: ProfileDraft;
        advanced: boolean;
    } | null>(null);
    const heading = useRef<HTMLHeadingElement>(null);
    const locked = Boolean(profileLocked && existing);
    useEffect(() => {
        heading.current?.focus();
    }, [step]);
    function patch(values: Partial<ProfileDraft>) {
        setDraft((current) => ({ ...current, ...values }));
        setError(null);
    }
    function select(provider: Provider, model: string) {
        if (draft.provider === provider && draft.model === model) return;
        const recommended = recommendedDraft(provider, model);
        const next = recommended ?? { ...draft, provider, model };
        const nextAdvanced = !recommended || advanced;
        if (profileDifferences(draft).length)
            setPending({ draft: next, advanced: nextAdvanced });
        else {
            setDraft(next);
            setAdvanced(nextAdvanced);
        }
    }
    function simple() {
        if (!advanced) return;
        const next = recommendedDraft(draft.provider, draft.model);
        if (!next) {
            setError('unsupportedSimple');
            return;
        }
        if (profileDifferences(draft).length)
            setPending({ draft: next, advanced: false });
        else setAdvanced(false);
    }
    function validate(destination: number) {
        if (!name.trim() || name.trim().length > 200) {
            setError('name');
            setStep(0);
            return false;
        }
        if (description.length > 2000) {
            setError('description');
            setStep(0);
            return false;
        }
        if (destination >= 2 && !locked) {
            const invalid = validateProfileDraft(draft);
            if (invalid) {
                setError(invalid);
                setStep(1);
                setAdvanced(true);
                setSection(
                    invalid === 'metadata'
                        ? 'metadata'
                        : invalid === 'chunking'
                          ? 'chunking'
                          : 'embedding'
                );
                return false;
            }
        }
        setError(null);
        setStep(destination);
        return true;
    }
    async function save() {
        if (!validate(2)) return;
        const parsed =
            locked && existing
                ? collectionProfile.strip().safeParse(existing.configuration)
                : profileFromDraft(draft);
        if (!parsed.success) {
            setError('invalid');
            return;
        }
        await mutation.run(
            () => {
                const input = {
                    name: name.trim(),
                    description,
                    profile: parsed.data,
                };
                return existing
                    ? client.admin.rag.collections.update({
                          ...input,
                          id: existing.id,
                          expectedRevision: existing.configurationRevision,
                      })
                    : client.admin.rag.collections.create({
                          ...input,
                          grantCreatorRead: grantRead,
                      });
            },
            (result) => {
                onClose();
                if (!existing)
                    router.push(`/dashboard/collections/${result.id}`);
            }
        );
    }
    return (
        <CatalogDialog
            title={existing ? tr('collections.edit') : tr('collections.create')}
            description={tr('editor.description')}
            busy={mutation.busy}
            onClose={onClose}
            framed
        >
            <form
                noValidate
                className='flex min-h-0 flex-col'
                onSubmit={(event) => {
                    event.preventDefault();
                    if (step < 2) validate(step + 1);
                    else void save();
                }}
            >
                <CollectionEditorSteps
                    step={step}
                    busy={mutation.busy}
                    onNavigate={(destination) => {
                        if (destination < step) {
                            setStep(destination);
                            setError(null);
                        } else validate(destination);
                    }}
                />
                <div
                    className='min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6'
                    data-collection-editor-body
                >
                    <h2
                        ref={heading}
                        tabIndex={-1}
                        className='mb-4 text-lg font-semibold outline-none'
                    >
                        {tr(editorStepTitles[step]!)}
                    </h2>
                    {error && (
                        <p
                            role='alert'
                            className='mb-4 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger'
                        >
                            {tr(`editor.errors.${error}`)}
                        </p>
                    )}
                    <fieldset disabled={mutation.busy} className='space-y-4'>
                        {step === 0 && (
                            <CollectionEditorDetails
                                name={name}
                                description={description}
                                grantRead={grantRead}
                                creating={!existing}
                                onNameChange={(value) => {
                                    setName(value);
                                    setError(null);
                                }}
                                onDescriptionChange={(value) => {
                                    setDescription(value);
                                    setError(null);
                                }}
                                onGrantReadChange={setGrantRead}
                            />
                        )}
                        {step === 1 && (
                            <CollectionEditorProfile
                                draft={draft}
                                advanced={advanced}
                                section={section}
                                locked={locked}
                                existing={existing}
                                onPatch={patch}
                                onSelect={select}
                                onSimple={simple}
                                onAdvanced={() => {
                                    setAdvanced(true);
                                    setError(null);
                                }}
                                onSectionChange={setSection}
                            />
                        )}
                        {step === 2 && (
                            <CollectionEditorReview
                                name={name}
                                description={description}
                                draft={effectiveProfileDraft(
                                    draft,
                                    existing?.configuration,
                                    locked
                                )}
                                editing={Boolean(existing)}
                            />
                        )}
                    </fieldset>
                </div>
                <CollectionEditorFooter
                    step={step}
                    busy={mutation.busy}
                    error={mutation.error}
                    editing={Boolean(existing)}
                    onBack={() => {
                        if (step === 0) onClose();
                        else {
                            setStep(step - 1);
                            setError(null);
                        }
                    }}
                    onContinue={() => validate(step + 1)}
                />
            </form>
            <ProfileResetDialog
                current={draft}
                next={pending?.draft ?? null}
                onClose={() => setPending(null)}
                onConfirm={() => {
                    if (pending) {
                        setDraft(pending.draft);
                        setAdvanced(pending.advanced);
                        setError(null);
                        setPending(null);
                    }
                }}
            />
        </CatalogDialog>
    );
}
