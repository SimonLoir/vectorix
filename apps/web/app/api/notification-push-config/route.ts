import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Exposes only the public half of the runtime Web Push configuration. */
export function GET() {
    const publicKey = process.env.VECTORIX_VAPID_PUBLIC_KEY?.trim();
    const enabled =
        process.env.VECTORIX_WEB_PUSH_ENABLED === 'true' && Boolean(publicKey);

    return NextResponse.json(
        { enabled, publicKey: enabled ? (publicKey ?? null) : null },
        { headers: { 'Cache-Control': 'no-store' } }
    );
}
