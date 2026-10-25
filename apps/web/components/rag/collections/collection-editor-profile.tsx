'use client';
import { useTranslations } from 'next-intl';
import { SlidersHorizontal, Sparkles } from 'lucide-react';
import { Button } from '@repo/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@repo/ui/tabs';
import { ProfileFields, type ProfileSection } from './profile-fields';
import { ProfileSummary } from './profile-summary';
import { ProfileDraftSummary } from './profile-draft-summary';
import type { ProfileDraft, Provider } from './profile-draft';
import type { Collection } from '../types';

const sections = [
    { value: 'embedding', label: 'editor.embedding' },
    { value: 'chunking', label: 'editor.chunking' },
    { value: 'metadata', label: 'editor.metadata' },
] as const;

/** Mount focused controls without moving draft ownership or tab keyboard focus. */
export function CollectionEditorProfile({
    draft,
    advanced,
    section,
    locked,
    existing,
    onPatch,
    onSelect,
    onSimple,
    onAdvanced,
    onSectionChange,
}: Readonly<{
    draft: ProfileDraft;
    advanced: boolean;
    section: ProfileSection;
    locked: boolean;
    existing?: Collection;
    onPatch: (patch: Partial<ProfileDraft>) => void;
    onSelect: (provider: Provider, model: string) => void;
    onSimple: () => void;
    onAdvanced: () => void;
    onSectionChange: (section: ProfileSection) => void;
}>) {
    const tr = useTranslations('rag');
    if (locked && existing)
        return (
            <section className='space-y-4'>
                <p
                    role='status'
                    className='rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm'
                >
                    {tr('indexing.rebuild.profileLocked')}
                </p>
                <ProfileSummary configuration={existing.configuration} />
            </section>
        );
    const fieldProps = {
        draft,
        onPatch,
        onSelect,
        advanced,
        configuration: existing?.configuration,
        collectionId: existing?.id,
        configurationRevision: existing?.configurationRevision,
    };
    return (
        <>
            <div className='flex flex-wrap items-center justify-between gap-3'>
                <div
                    role='group'
                    aria-label={tr('editor.mode')}
                    className='inline-flex gap-1 rounded-lg border bg-muted/40 p-1'
                >
                    <Button
                        type='button'
                        variant={advanced ? 'ghost' : 'default'}
                        size='sm'
                        aria-pressed={!advanced}
                        onClick={onSimple}
                    >
                        <Sparkles className='size-4' aria-hidden />
                        {tr('editor.simple')}
                    </Button>
                    <Button
                        type='button'
                        variant={advanced ? 'default' : 'ghost'}
                        size='sm'
                        aria-pressed={advanced}
                        onClick={onAdvanced}
                    >
                        <SlidersHorizontal className='size-4' aria-hidden />
                        {tr('editor.advanced')}
                    </Button>
                </div>
                {advanced && (
                    <p className='text-xs text-muted-foreground'>
                        {tr('editor.draftPreserved')}
                    </p>
                )}
            </div>
            {advanced ? (
                <Tabs
                    value={section}
                    onValueChange={(value) => {
                        if (
                            value === 'embedding' ||
                            value === 'chunking' ||
                            value === 'metadata'
                        )
                            onSectionChange(value);
                    }}
                >
                    <TabsList
                        aria-label={tr('editor.sections')}
                        className='w-full'
                    >
                        {sections.map((item) => (
                            <TabsTrigger key={item.value} value={item.value}>
                                {tr(item.label)}
                            </TabsTrigger>
                        ))}
                    </TabsList>
                    {sections.map((item) => (
                        <TabsContent
                            key={item.value}
                            value={item.value}
                            className='pt-3'
                        >
                            <ProfileFields
                                {...fieldProps}
                                section={item.value}
                            />
                        </TabsContent>
                    ))}
                </Tabs>
            ) : (
                <ProfileFields {...fieldProps} section={section} />
            )}
        </>
    );
}

/** Show the same pending values that the parent will validate and submit. */
export function CollectionEditorReview({
    name,
    description,
    draft,
    editing,
}: Readonly<{
    name: string;
    description: string;
    draft: ProfileDraft;
    editing: boolean;
}>) {
    const tr = useTranslations('rag');
    return (
        <>
            <div className='rounded-xl border bg-card p-4'>
                <h3 className='break-words text-lg font-semibold'>
                    {name.trim()}
                </h3>
                {description && (
                    <p className='mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-sm text-muted-foreground'>
                        {description}
                    </p>
                )}
                <p className='mt-3 break-all text-sm font-medium text-info'>
                    {draft.provider} · {draft.model}
                </p>
            </div>
            <ProfileDraftSummary draft={draft} detailed />
            <p className='text-xs leading-relaxed text-muted-foreground'>
                {tr('collections.bindingHint')}
            </p>
            {editing && (
                <p className='rounded-lg border border-warning/25 bg-warning/5 p-3 text-sm'>
                    {tr('editor.rebuildHint')}
                </p>
            )}
        </>
    );
}
