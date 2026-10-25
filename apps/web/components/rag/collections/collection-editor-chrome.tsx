'use client';
import { useTranslations } from 'next-intl';
import { Check, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@repo/ui/button';
import { cn } from '@repo/ui/utils';
import { IndexError } from '../indexing/index-state';
import { TextField, AreaField, CheckField } from '../form-fields';

export const editorStepTitles = [
    'editor.titles.details',
    'editor.titles.profile',
    'editor.titles.review',
] as const;
const stepLabels = [
    'editor.steps.details',
    'editor.steps.profile',
    'editor.steps.review',
] as const;

/** Navigation never owns draft values or performs the final catalog mutation. */
export function CollectionEditorSteps({
    step,
    busy,
    onNavigate,
}: Readonly<{
    step: number;
    busy: boolean;
    onNavigate: (step: number) => void;
}>) {
    const tr = useTranslations('rag');
    return (
        <ol
            aria-label={tr('editor.progress')}
            className='grid shrink-0 grid-cols-3 border-b bg-muted/25 px-4 py-3 sm:px-6'
        >
            {stepLabels.map((label, index) => (
                <li key={label}>
                    <button
                        type='button'
                        disabled={busy}
                        aria-current={step === index ? 'step' : undefined}
                        onClick={() => onNavigate(index)}
                        className={cn(
                            'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs font-medium transition-colors sm:text-sm',
                            step === index
                                ? 'bg-info/10 text-info'
                                : 'text-muted-foreground hover:bg-muted'
                        )}
                    >
                        <span
                            className={cn(
                                'flex size-6 shrink-0 items-center justify-center rounded-full border',
                                step === index
                                    ? 'border-primary bg-primary text-primary-foreground'
                                    : 'border-border'
                            )}
                        >
                            {index < step ? (
                                <Check className='size-3.5' aria-hidden />
                            ) : (
                                index + 1
                            )}
                        </span>
                        {tr(label)}
                    </button>
                </li>
            ))}
        </ol>
    );
}

/** Identity fields stay controlled by the parent while their step is unmounted. */
export function CollectionEditorDetails({
    name,
    description,
    grantRead,
    creating,
    onNameChange,
    onDescriptionChange,
    onGrantReadChange,
}: Readonly<{
    name: string;
    description: string;
    grantRead: boolean;
    creating: boolean;
    onNameChange: (value: string) => void;
    onDescriptionChange: (value: string) => void;
    onGrantReadChange: (value: boolean) => void;
}>) {
    const tr = useTranslations('rag');
    return (
        <>
            <TextField
                label={tr('collections.name')}
                name='name'
                required
                maxLength={200}
                value={name}
                onChange={(event) => onNameChange(event.target.value)}
            />
            <AreaField
                label={tr('common.description')}
                name='description'
                maxLength={2000}
                rows={3}
                value={description}
                onChange={(event) => onDescriptionChange(event.target.value)}
            />
            {creating && (
                <div className='rounded-lg bg-muted/40 p-3'>
                    <CheckField
                        name='grantCreatorRead'
                        label={tr('collections.grantSelf')}
                        checked={grantRead}
                        onChange={(event) =>
                            onGrantReadChange(event.target.checked)
                        }
                    />
                </div>
            )}
        </>
    );
}

/** Keep navigation and mutation feedback outside the editor's scrolling body. */
export function CollectionEditorFooter({
    step,
    busy,
    error,
    editing,
    onBack,
    onContinue,
}: Readonly<{
    step: number;
    busy: boolean;
    error: string | null;
    editing: boolean;
    onBack: () => void;
    onContinue: () => void;
}>) {
    const tr = useTranslations('rag');
    return (
        <footer className='shrink-0 space-y-3 border-t bg-background px-4 py-4 sm:px-6'>
            <IndexError error={error} />
            <div className='flex items-center justify-between gap-3'>
                <Button
                    type='button'
                    variant='ghost'
                    disabled={busy}
                    onClick={onBack}
                >
                    {step === 0 ? (
                        tr('common.cancel')
                    ) : (
                        <>
                            <ChevronLeft className='size-4' aria-hidden />
                            {tr('editor.back')}
                        </>
                    )}
                </Button>
                {step < 2 ? (
                    <Button
                        type='button'
                        disabled={busy}
                        onClick={(event) => {
                            // React can reuse this node as the submit button after
                            // navigation; cancel this click's native default first.
                            event.preventDefault();
                            onContinue();
                        }}
                    >
                        {tr('editor.continue')}
                        <ChevronRight className='size-4' aria-hidden />
                    </Button>
                ) : (
                    <Button type='submit' disabled={busy}>
                        {busy
                            ? tr('common.saving')
                            : tr(
                                  editing
                                      ? 'editor.saveProfile'
                                      : 'editor.createCollection'
                              )}
                    </Button>
                )}
            </div>
        </footer>
    );
}
