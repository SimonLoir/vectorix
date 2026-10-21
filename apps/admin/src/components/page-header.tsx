export function PageHeader({
    title,
    description,
    action,
}: Readonly<{
    title: string;
    description: string;
    action?: React.ReactNode;
}>) {
    return (
        <div className='flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between'>
            <div>
                <h1 className='text-3xl font-semibold tracking-[-0.035em] text-slate-100 sm:text-4xl'>
                    {title}
                </h1>
                <p className='mt-2 max-w-3xl text-sm leading-6 text-slate-400'>
                    {description}
                </p>
            </div>
            {action}
        </div>
    );
}
