export type NotificationEventType = 'ACCOUNT_SIGN_IN';
export type NotificationSource = Readonly<{
    kind: 'ACCOUNT_SIGN_IN';
    id: string;
    version: number;
}>;
export type NotificationAction = Readonly<{ kind: 'ACCOUNT'; version: 1 }>;
export type NotificationRecipient = Readonly<{
    kind: 'MEMBER';
    memberId: string;
}>;
export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL', 'PUSH'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
