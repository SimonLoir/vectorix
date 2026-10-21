'use client';

import Link from 'next/link';
import { Settings2Icon } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { BreadCrumbs } from '@repo/dashboard-core/components/app-page-context';
import PageDescription from '@repo/dashboard-core/components/page-description';
import PageTitle from '@repo/dashboard-core/components/page-title';
import { Button } from '@repo/ui/button';
import { Card, CardContent, CardHeader } from '@repo/ui/card';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@repo/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@repo/ui/tabs';
import DashboardPage from '@/components/dashboard-page';
import {
    NotificationList,
    NOTIFICATION_SOURCE_FILTERS,
    type NotificationSourceFilter,
} from '@/components/notifications/notification-list';

function parseSource(value: string | null): NotificationSourceFilter {
    return NOTIFICATION_SOURCE_FILTERS.includes(
        value as NotificationSourceFilter
    )
        ? (value as NotificationSourceFilter)
        : 'ALL';
}

export default function NotificationsPage() {
    const t = useTranslations('notifications');
    const breadcrumbs = useTranslations('breadcrumbs');
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const unreadOnly = searchParams.get('status') === 'unread';
    const source = parseSource(searchParams.get('source'));

    const updateFilter = (name: 'status' | 'source', value: string) => {
        const params = new URLSearchParams(searchParams.toString());
        if (
            (name === 'status' && value === 'all') ||
            (name === 'source' && value === 'ALL')
        ) {
            params.delete(name);
        } else {
            params.set(name, value);
        }
        const query = params.toString();
        router.replace(query ? `${pathname}?${query}` : pathname, {
            scroll: false,
        });
    };

    return (
        <DashboardPage className='space-y-6'>
            <BreadCrumbs
                breadcrumbs={[
                    { title: breadcrumbs('dashboard'), url: '/dashboard' },
                    { title: t('title') },
                ]}
            />
            <div className='flex flex-wrap items-start justify-between gap-3'>
                <div>
                    <PageTitle>{t('title')}</PageTitle>
                    <PageDescription>{t('description')}</PageDescription>
                </div>
                <Button variant='outline' asChild>
                    <Link href='/dashboard/notifications/preferences'>
                        <Settings2Icon aria-hidden='true' />
                        {t('preferencesLink')}
                    </Link>
                </Button>
            </div>
            <Card>
                <CardHeader className='flex flex-row flex-wrap items-center justify-between gap-3'>
                    <Tabs
                        value={unreadOnly ? 'unread' : 'all'}
                        onValueChange={(value) => updateFilter('status', value)}
                    >
                        <TabsList aria-label={t('statusFilterLabel')}>
                            <TabsTrigger value='all'>{t('all')}</TabsTrigger>
                            <TabsTrigger value='unread'>
                                {t('unread')}
                            </TabsTrigger>
                        </TabsList>
                    </Tabs>
                    <Select
                        value={source}
                        onValueChange={(value) => updateFilter('source', value)}
                    >
                        <SelectTrigger
                            className='w-full sm:w-60'
                            aria-label={t('sourceFilterLabel')}
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent align='end'>
                            {NOTIFICATION_SOURCE_FILTERS.map((filter) => (
                                <SelectItem key={filter} value={filter}>
                                    {t(`sources.${filter}`)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </CardHeader>
                <CardContent className='p-0'>
                    <NotificationList
                        key={`${unreadOnly}:${source}`}
                        unreadOnly={unreadOnly}
                        source={source}
                    />
                </CardContent>
            </Card>
        </DashboardPage>
    );
}
