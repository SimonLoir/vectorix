export interface MailServiceOptions {
    nodeMailer?: {
        host: string;
        port: number;
        secure: boolean;
        connectionTimeout?: number;
        socketTimeout?: number;
        auth?: {
            user: string;
            pass: string;
        };
    };
    resend?: {
        APIKey: string;
    };
    awsSES?: {
        accessKeyId: string;
        secretAccessKey: string;
        region: string;
    };
}
