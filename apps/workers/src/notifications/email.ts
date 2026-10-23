import { escapeHtml } from '@repo/emails';
import { accountSignInMessages } from '@routers/utils/notifications';

/**
 * Render using the recipient's current saved language at delivery time. Inbox and
 * push retain their creation snapshot. Frozen event facts are escaped, never
 * interpreted as markup or re-parsed into mutable source records.
 */
export function renderAccountSignInEmail(input: {
    savedLocale: unknown;
    title: string;
    body: string;
    accountUrl: string;
}) {
    const text = accountSignInMessages(input.savedLocale);
    const details =
        input.body === input.title ? '' : `<p>${escapeHtml(input.body)}</p>`;
    return {
        subject: text.title,
        html: `<div lang="${text.locale}"><h1>${escapeHtml(text.title)}</h1>${details}<p><a href="${escapeHtml(input.accountUrl)}">${escapeHtml(text.action)}</a></p></div>`,
    };
}
