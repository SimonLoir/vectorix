import { cn } from '@repo/ui/utils';

/** Vectorix logo mark; inherits the brand color from the theme tokens. */
export function BrandMark({ className }: Readonly<{ className?: string }>) {
    return (
        <svg
            viewBox='0 0 64 64'
            aria-hidden='true'
            className={cn('text-primary', className)}
        >
            <rect width='64' height='64' rx='14' fill='currentColor' />
            <path
                d='M15 17 32 48 49 17H39L32 32 25 17Z'
                className='fill-primary-foreground'
            />
        </svg>
    );
}
