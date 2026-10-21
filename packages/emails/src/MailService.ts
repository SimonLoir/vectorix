import { MailServiceOptions } from './MailServiceOptions';
import { MailClient } from './MailClient';
import ResendClient from './MailClient/ResendClient';
import NodeMailerClient from './MailClient/NodeMailerClient';
import { SendMailOptions } from './SendMailOptions';
import MailClientSuccess from './MailClient/MailClientSuccess';
import MailClientError from './MailClient/MailClientError';

export default class MailService {
    private readonly __mailClient: MailClient | undefined;
    constructor(private __options: MailServiceOptions = {}) {
        if (__options.resend !== undefined) {
            this.__mailClient = new ResendClient({ resend: __options.resend });
        } else if (__options.nodeMailer !== undefined) {
            this.__mailClient = new NodeMailerClient({
                nodeMailer: __options.nodeMailer,
            });
        }
    }

    async sendMail(
        to: string,
        subject: string,
        html: string,
        from?: string
    ): Promise<void> {
        if (this.__mailClient === undefined) {
            throw new Error('No mail client found');
        }
        await this.__mailClient.sendMail(to, subject, html, from);
    }

    async send(
        options: SendMailOptions
    ): Promise<MailClientSuccess | MailClientError> {
        if (this.__mailClient === undefined) {
            throw new Error('No mail client found');
        }
        return await this.__mailClient.send(options);
    }

    async sendBulk(
        options: SendMailOptions[]
    ): Promise<MailClientSuccess | MailClientError> {
        if (this.__mailClient === undefined) {
            throw new Error('No mail client found');
        }
        return await this.__mailClient.sendBulk(options);
    }
}
