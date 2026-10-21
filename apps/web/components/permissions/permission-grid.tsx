'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { statements, type PermissionSet } from '@repo/auth/permissions';
import { Checkbox } from '@repo/ui/checkbox';
import { Label } from '@repo/ui/label';

const API_KEY_EXCLUDED_RESOURCES = new Set([
    'organization',
    'member',
    'invitation',
    'team',
    'ac',
    'apiKey',
]);

const isVisibleResource = (resource: string, apiKey: boolean) =>
    resource !== 'maintenance' &&
    (!apiKey || !API_KEY_EXCLUDED_RESOURCES.has(resource));

export function getSelectablePermissions(
    allowed: PermissionSet,
    apiKey = false
): PermissionSet {
    const selectable: PermissionSet = {};
    for (const [resource, actions] of Object.entries(statements)) {
        if (!isVisibleResource(resource, apiKey)) continue;
        const allowedActions = actions.filter((action) =>
            allowed[resource]?.includes(action)
        );
        if (allowedActions.length > 0) selectable[resource] = allowedActions;
    }
    return selectable;
}

/** Reuses the server catalogue for both custom role editing and scoped API keys. */
export function PermissionGrid({
    value,
    onChange,
    allowed,
    apiKey = false,
    readOnly = false,
}: {
    readonly value: PermissionSet;
    readonly onChange: (value: PermissionSet) => void;
    readonly allowed: PermissionSet;
    readonly apiKey?: boolean;
    readonly readOnly?: boolean;
}) {
    const id = useId();
    const t = useTranslations('permissions');
    const resources = Object.entries(statements).filter(([resource]) =>
        isVisibleResource(resource, apiKey)
    );
    return (
        <div className='space-y-4'>
            {resources.map(([resource, actions]) => (
                <fieldset key={resource} className='rounded-lg border p-4'>
                    <legend className='px-1 text-sm font-medium'>
                        {t(`modules.${resource}`)}
                    </legend>
                    <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
                        {actions.map((action) => (
                            <div
                                key={action}
                                className='flex items-center gap-2'
                            >
                                <Checkbox
                                    id={`${id}-${resource}-${action}`}
                                    checked={
                                        value[resource]?.includes(action) ??
                                        false
                                    }
                                    disabled={
                                        readOnly ||
                                        !allowed[resource]?.includes(action)
                                    }
                                    onCheckedChange={(checked) => {
                                        const actions = value[resource] ?? [];
                                        onChange({
                                            ...value,
                                            [resource]:
                                                checked === true
                                                    ? [
                                                          ...new Set([
                                                              ...actions,
                                                              action,
                                                          ]),
                                                      ]
                                                    : actions.filter(
                                                          (existing) =>
                                                              existing !==
                                                              action
                                                      ),
                                        });
                                    }}
                                />
                                <Label htmlFor={`${id}-${resource}-${action}`}>
                                    {t(`actions.${action}`)}
                                </Label>
                            </div>
                        ))}
                    </div>
                </fieldset>
            ))}
        </div>
    );
}
