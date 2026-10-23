import MailService from './MailService';
import {
    resolveSystemMailConfiguration,
    SystemMailError,
} from './system-mail-configuration';

/**
 * Deliver through one freshly resolved server transport. Failures are sanitized
 * and never trigger fallback: an ambiguous accepted send must not be duplicated.
 * Notification callers retain responsibility for their existing durable retries.
 */
export async function sendSystemMail(
    to: string,
    subject: string,
    html: string
) {
    const configuration = resolveSystemMailConfiguration();
    try {
        const service = new MailService(
            configuration.provider === 'resend'
                ? { resend: { APIKey: configuration.apiKey } }
                : {
                      nodeMailer: {
                          host: configuration.host,
                          port: configuration.port,
                          secure: configuration.port === 465,
                          connectionTimeout: 10_000,
                          socketTimeout: 30_000,
                          ...(configuration.auth
                              ? { auth: configuration.auth }
                              : {}),
                      },
                  }
        );
        await service.sendMail(to, subject, html, configuration.senderEmail);
    } catch {
        throw new SystemMailError('SYSTEM_MAIL_DELIVERY_FAILED');
    }
}
export function escapeHtml(value: string) {
    return value.replaceAll(
        /[&<>"']/g,
        (character) =>
            ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            })[character]!
    );
}
