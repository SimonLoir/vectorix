import type { Handler } from 'hono';

export const SCALAR_ICON_PATH = '/_playground/icon.svg';
const ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="10" fill="#09090b"/><path d="M11 12h6l7 21 7-21h6L27 39h-6z" fill="#fff"/></svg>';

/** Fixed local artwork with no remote references, user content or executable SVG features. */
export const scalarIconHandler: Handler = (context) => {
    context.header('Content-Type', 'image/svg+xml; charset=utf-8');
    context.header('Cache-Control', 'public, max-age=3600');
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('Content-Security-Policy', "default-src 'none'; sandbox");
    return context.body(ICON);
};
