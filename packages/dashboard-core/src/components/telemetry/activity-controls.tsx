'use client';
import { useId } from 'react';
import { Button } from '@repo/ui/button';
import { Label } from '@repo/ui/label';
import {
    activityWindows,
    type ActivityText,
    type ActivityWindow,
} from './types';

export function ActivityControls({
    window,
    onWindow,
    refreshing,
    refresh,
    text,
}: Readonly<{
    window: ActivityWindow;
    onWindow: (value: ActivityWindow) => void;
    refreshing: boolean;
    refresh: () => void;
    text: ActivityText;
}>) {
    const id = useId();
    return (
        <div className='flex flex-wrap items-end gap-3'>
            <div className='space-y-2'>
                <Label htmlFor={id}>{text('window')}</Label>
                <select
                    id={id}
                    value={window}
                    className='h-10 rounded-md border border-input bg-background px-3 text-sm'
                    onChange={(event) => {
                        const selected = activityWindows.find(
                            (value) => value === event.target.value
                        );
                        if (selected) onWindow(selected);
                    }}
                >
                    {activityWindows.map((value) => (
                        <option value={value} key={value}>
                            {text(`windows.${value}`)}
                        </option>
                    ))}
                </select>
            </div>
            <Button
                type='button'
                variant='outline'
                disabled={refreshing}
                onClick={refresh}
            >
                {text(refreshing ? 'refreshing' : 'refresh')}
            </Button>
        </div>
    );
}
