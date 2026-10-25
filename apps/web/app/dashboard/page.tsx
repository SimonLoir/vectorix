'use client';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { ArrowUpRight, Database, FileText, Search } from 'lucide-react';
import { Button } from '@repo/ui/button';
import DashboardPage from '@/components/dashboard-page';
import { HomeSearch } from '@/components/rag/home/home-search';

export default function Dashboard() {
    const tr = useTranslations('rag.searchHome');
    return (
        <DashboardPage className='space-y-8 py-8 sm:py-12'>
            <header className='mx-auto max-w-3xl space-y-4 text-center'>
                <span className='mx-auto inline-flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary dark:text-accent-foreground'>
                    <Search className='size-6' aria-hidden />
                </span>
                <p className='text-sm font-medium text-muted-foreground'>
                    {tr('eyebrow')}
                </p>
                <h1 className='text-3xl font-semibold tracking-tight sm:text-5xl'>
                    {tr('title')}
                </h1>
                <p className='mx-auto max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base'>
                    {tr('description')}
                </p>
            </header>
            <div className='mx-auto w-full max-w-5xl'>
                <HomeSearch />
            </div>
            <nav
                aria-label={tr('shortcuts')}
                className='flex flex-wrap justify-center gap-3'
            >
                <Button asChild variant='outline' className='bg-card'>
                    <Link href='/dashboard/collections'>
                        <Database className='size-4' aria-hidden />
                        {tr('collections')}
                        <ArrowUpRight
                            className='size-3.5 text-muted-foreground'
                            aria-hidden
                        />
                    </Link>
                </Button>
                <Button asChild variant='outline' className='bg-card'>
                    <Link href='/dashboard/documents'>
                        <FileText className='size-4' aria-hidden />
                        {tr('documents')}
                        <ArrowUpRight
                            className='size-3.5 text-muted-foreground'
                            aria-hidden
                        />
                    </Link>
                </Button>
            </nav>
        </DashboardPage>
    );
}
