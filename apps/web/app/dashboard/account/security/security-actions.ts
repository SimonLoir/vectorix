'use client';

import { useRef, useState } from 'react';
import { securityErrorKey, type SecurityErrorKey } from './security-errors';

type ActionResult =
    { success: true } | { success: false; error: SecurityErrorKey };
export type SecurityActions = {
    busy: boolean;
    perform: (
        operation: () => Promise<{ error?: unknown }>
    ) => Promise<ActionResult>;
};

/** Serialize security mutations; every completion, failure and cancellation unlocks the UI. */
export function useSecurityActions(): SecurityActions {
    const [busy, setBusy] = useState(false);
    const active = useRef(false);
    return {
        busy,
        perform: async (operation) => {
            if (active.current) return { success: false, error: 'busy' };
            active.current = true;
            setBusy(true);
            try {
                const response = await operation();
                return response.error
                    ? {
                          success: false,
                          error: securityErrorKey(response.error),
                      }
                    : { success: true };
            } catch (error) {
                return { success: false, error: securityErrorKey(error) };
            } finally {
                active.current = false;
                setBusy(false);
            }
        },
    };
}
