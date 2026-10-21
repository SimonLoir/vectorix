import MailService from './MailService';
/** Deliver system mail using server-only configuration; never log tokens or recipient contents. */
export async function sendSystemMail(
    to: string,
    subject: string,
    html: string
) {
    const apiKey = process.env.VECTORIX_DEFAULT_RESEND_API_KEY;
    const host = process.env.VECTORIX_DEFAULT_SMTP_HOST;
    if (!apiKey && !host)
        throw new Error('System email provider is not configured');
    const service = new MailService(
        apiKey
            ? { resend: { APIKey: apiKey } }
            : {
                  nodeMailer: {
                      host: host!,
                      port: Number(
                          process.env.VECTORIX_DEFAULT_SMTP_PORT ?? 587
                      ),
                      secure: process.env.VECTORIX_DEFAULT_SMTP_PORT === '465',
                      connectionTimeout: 10_000,
                      socketTimeout: 30_000,
                      ...(process.env.VECTORIX_DEFAULT_SMTP_USER
                          ? {
                                auth: {
                                    user: process.env
                                        .VECTORIX_DEFAULT_SMTP_USER,
                                    pass:
                                        process.env
                                            .VECTORIX_DEFAULT_SMTP_PASSWORD ??
                                        '',
                                },
                            }
                          : {}),
                  },
              }
    );
    return await service.sendMail(
        to,
        subject,
        html,
        process.env.VECTORIX_DEFAULT_RESEND_SENDER_EMAIL ??
            process.env.VECTORIX_DEFAULT_SMTP_SENDER_EMAIL ??
            'noreply@example.com'
    );
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
