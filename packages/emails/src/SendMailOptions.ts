export interface MailAttachment {
    /** File name of the attachment */
    filename: string;
    /** Content of the attachment as a Buffer or base64-encoded string */
    content: Buffer | string;
    /** Optional MIME type (e.g. 'application/pdf') */
    contentType?: string;
}

export type SendMailOptions = {
    from: string;
    to: string | string[];
    subject: string;
    cc?: string | string[];
    bcc?: string | string[];

    replyTo?: string | string[];
    attachments?: MailAttachment[];
    /** Per-message headers, including newsletter unsubscribe metadata. */
    headers?: Record<string, string>;
} & (
    | {
          text: string;
          html?: never;
      }
    | {
          text?: never;
          html: string;
      }
);
