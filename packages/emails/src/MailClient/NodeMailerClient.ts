import { MailServiceOptions } from '../MailServiceOptions';
import MailClient from './MailClient';
import { createTransport, Transporter } from 'nodemailer';
import { SendMailOptions } from '../SendMailOptions';
import MailClientSuccess from './MailClientSuccess';
import MailClientError from './MailClientError';

export default class NodeMailerClient extends MailClient {
    private __transporter: Transporter;
    constructor(
        private __options: Required<Pick<MailServiceOptions, 'nodeMailer'>>
    ) {
        super(__options);
        this.__transporter = createTransport(__options.nodeMailer);
    }

    private toNodeMailerOptions(options: SendMailOptions) {
        return {
            from: options.from,
            to: options.to,
            subject: options.subject,
            ...(options.html ? { html: options.html } : { text: options.text }),
            cc: options.cc,
            bcc: options.bcc,
            replyTo: options.replyTo,
            headers: options.headers,
            attachments: options.attachments?.map((a) => ({
                filename: a.filename,
                content: a.content,
                contentType: a.contentType,
            })),
        };
    }

    async sendMail(
        to: string,
        subject: string,
        html: string,
        from: string
    ): Promise<void> {
        await this.__transporter.sendMail({
            from,
            to,
            subject,
            html,
        });
    }

    async send(
        options: SendMailOptions
    ): Promise<MailClientSuccess | MailClientError> {
        const result = await this.__transporter.sendMail(
            this.toNodeMailerOptions(options)
        );
        return new MailClientSuccess(result);
    }

    async sendBulk(
        options: SendMailOptions[]
    ): Promise<MailClientSuccess | MailClientError> {
        try {
            const results = await Promise.all(
                options.map((option) =>
                    this.__transporter.sendMail(
                        this.toNodeMailerOptions(option)
                    )
                )
            );

            return new MailClientSuccess(results);
        } catch (err) {
            return new MailClientError(
                err instanceof Error
                    ? err.message
                    : 'Failed to send bulk emails'
            );
        }
    }
}
