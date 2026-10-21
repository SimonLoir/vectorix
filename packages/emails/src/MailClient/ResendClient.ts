import { Resend } from 'resend';
import { MailServiceOptions } from '../MailServiceOptions';
import MailClient from './MailClient';
import { SendMailOptions } from '../SendMailOptions';
import MailClientError from './MailClientError';
import MailClientSuccess from './MailClientSuccess';

export default class ResendClient extends MailClient {
    private __resend: Resend;
    constructor(
        private __options: Required<Pick<MailServiceOptions, 'resend'>>
    ) {
        super(__options);
        this.__resend = new Resend(__options.resend.APIKey);
    }

    async sendMail(
        to: string,
        subject: string,
        html: string,
        from: string
    ): Promise<void> {
        const result = await this.__resend.emails.send({
            from,
            to,
            subject,
            html,
        });
        if (result.error) throw new Error(result.error.message);
    }

    async send({
        to,
        subject,
        html,
        from: from,
        replyTo,
        cc,
        bcc,
        text,
        attachments,
        headers,
    }: SendMailOptions) {
        const result = await this.__resend.emails.send({
            to,
            subject,
            from,
            text: text as string,
            html,
            replyTo,
            cc,
            bcc,
            headers,
            attachments: attachments?.map((a) => ({
                filename: a.filename,
                content: a.content,
                contentType: a.contentType,
            })),
        });
        if (result.error) {
            return new MailClientError(result.error.message);
        }

        return new MailClientSuccess(result.data);
    }

    async sendBulk(
        options: SendMailOptions[]
    ): Promise<MailClientSuccess | MailClientError> {
        const result = await this.__resend.batch.send(
            options.map(
                ({
                    to,
                    subject,
                    html,
                    from: from,
                    replyTo,
                    cc,
                    bcc,
                    text,
                    headers,
                }) => ({
                    to,
                    subject,
                    from,
                    text: text as string,
                    html,
                    replyTo,
                    cc,
                    bcc,
                    headers,
                })
            )
        );
        if (result.error) {
            return new MailClientError(result.error.message);
        }

        return new MailClientSuccess(result.data);
    }
}
