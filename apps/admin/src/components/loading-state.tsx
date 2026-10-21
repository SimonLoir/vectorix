import { LoaderCircle } from 'lucide-react';

export function LoadingState({
    label = 'Chargement…',
}: {
    readonly label?: string;
}) {
    return (
        <div className='flex min-h-48 items-center justify-center gap-3 text-sm text-muted-foreground'>
            <LoaderCircle className='h-5 w-5 animate-spin' />
            {label}
        </div>
    );
}
