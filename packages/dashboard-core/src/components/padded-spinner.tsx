import { Spinner } from '@repo/ui/spinner';
import { cn } from '@repo/ui/utils';

export default function PaddedSpinner({
    className,
    spinnerClassName,
}: Readonly<{ className?: string; spinnerClassName?: string }>) {
    return (
        <div className={cn('grid items-center justify-center h-32', className)}>
            <Spinner className={spinnerClassName} />
        </div>
    );
}
