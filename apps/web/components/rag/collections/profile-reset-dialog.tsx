'use client';
import { useFormatter, useTranslations } from 'next-intl';
import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogCancel,
    AlertDialogAction,
} from '@repo/ui/alert-dialog';
import type { ProfileDraft } from './profile-draft';

const labels: Record<keyof ProfileDraft, string> = {
    provider: 'profile.provider',
    model: 'profile.model',
    dimensions: 'profile.dimensions',
    indexType: 'profile.index',
    embeddingPreset: 'indexing.preset',
    preparation: 'profile.preparation',
    chunkingStrategy: 'profile.chunking',
    parentChild: 'profile.parentChild',
    targetTokens: 'profile.target',
    overlapTokens: 'profile.overlap',
    minTokens: 'profile.minimum',
    maxTokens: 'profile.maximum',
    semanticPercentile: 'profile.percentile',
    parentMaxTokens: 'profile.parentMaximum',
    metadataRows: 'indexing.metadataFields',
};

export function ProfileResetDialog({
    current,
    next,
    onConfirm,
    onClose,
}: Readonly<{
    current: ProfileDraft;
    next: ProfileDraft | null;
    onConfirm: () => void;
    onClose: () => void;
}>) {
    const tr = useTranslations('rag');
    const format = useFormatter();
    function display(key: keyof ProfileDraft, draft: ProfileDraft): string {
        const value = draft[key];
        if (key === 'metadataRows')
            return tr('editor.fieldCount', {
                count: draft.metadataRows.length,
            });
        if (key === 'embeddingPreset')
            return tr(`indexing.presets.${draft.embeddingPreset}`);
        if (key === 'chunkingStrategy')
            return tr(
                {
                    DOCUMENT_STRUCTURE: 'profile.structure',
                    TOKEN_WINDOW: 'profile.tokens',
                    SEMANTIC: 'profile.semantic',
                }[draft.chunkingStrategy]
            );
        if (typeof value === 'boolean')
            return tr(value ? 'common.enabled' : 'common.disabled');
        return typeof value === 'string' &&
            value.trim() !== '' &&
            Number.isFinite(Number(value))
            ? format.number(Number(value))
            : String(value || '—');
    }
    const keys = next
        ? (Object.keys(next) as (keyof ProfileDraft)[]).filter(
              (key) =>
                  JSON.stringify(current[key]) !== JSON.stringify(next[key])
          )
        : [];
    return (
        <AlertDialog
            open={next !== null}
            onOpenChange={(open) => {
                if (!open) onClose();
            }}
        >
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {tr('editor.resetTitle')}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {tr('editor.resetDescription')}
                    </AlertDialogDescription>
                </AlertDialogHeader>
                <dl className='max-h-[40dvh] space-y-3 overflow-y-auto rounded-lg bg-muted/50 p-4 text-sm'>
                    {keys.map((key) => (
                        <div key={key}>
                            <dt className='font-medium'>{tr(labels[key])}</dt>
                            <dd className='mt-1 break-words text-muted-foreground'>
                                {tr('editor.valueChange', {
                                    before: display(key, current),
                                    after: next ? display(key, next) : '—',
                                })}
                            </dd>
                        </div>
                    ))}
                </dl>
                <AlertDialogFooter>
                    <AlertDialogCancel onClick={onClose}>
                        {tr('editor.keepSettings')}
                    </AlertDialogCancel>
                    <AlertDialogAction onClick={onConfirm}>
                        {tr('editor.applyDefaults')}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
