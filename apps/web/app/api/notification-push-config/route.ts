import { NextResponse } from 'next/server';
import { createPushEndpointPolicy } from '@routers/utils/push-endpoint-policy';

export const dynamic = 'force-dynamic';

/** Exposes only the public half of the runtime Web Push configuration. */
export function GET() {
    const publicKey = process.env.VECTORIX_VAPID_PUBLIC_KEY?.trim();
    let enabled =
        process.env.VECTORIX_WEB_PUSH_ENABLED === 'true' && Boolean(publicKey);
    try {
        createPushEndpointPolicy(process.env.VECTORIX_WEB_PUSH_ALLOWED_ORIGINS);
    } catch {
        enabled = false;
    }

    return NextResponse.json(
        { enabled, publicKey: enabled ? (publicKey ?? null) : null },
        { headers: { 'Cache-Control': 'no-store' } }
    );
}
