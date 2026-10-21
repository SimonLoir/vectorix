'use client';

import { useEffect } from 'react';

/** Registers the dashboard worker; Web Push delivery remains separately feature-gated. */
export function PwaRegistration() {
    useEffect(() => {
        if (!('serviceWorker' in navigator)) return;

        let disposed = false;
        void navigator.serviceWorker
            .register('/sw.js', { scope: '/', updateViaCache: 'none' })
            .then((registration) => {
                if (!disposed) void registration.update();
            })
            .catch(() => {
                // The account preference surface reports unsupported/failed setup.
            });
        return () => {
            disposed = true;
        };
    }, []);

    return null;
}
