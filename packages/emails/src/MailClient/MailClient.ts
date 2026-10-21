import { MailServiceOptions } from '../MailServiceOptions';
import { SendMailOptions } from '../SendMailOptions';
import MailClientError from './MailClientError';
import MailClientSuccess from './MailClientSuccess';
import React from 'react';

export default abstract class MailClient {
    constructor(private options: MailServiceOptions) {}

    abstract sendMail(
        to: string,
        subject: string,
        html: string | React.FC,
        from?: string
    ): Promise<void>;

    abstract send(
        options: SendMailOptions
    ): Promise<MailClientError | MailClientSuccess>;

    abstract sendBulk(
        options: SendMailOptions[]
    ): Promise<MailClientError | MailClientSuccess>;
}
