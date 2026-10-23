import type {
    NotificationPushReceipt,
    notificationPushRegistrationInput,
} from './notification-push';

type RegistrationInput = ReturnType<typeof notificationPushRegistrationInput>;
export type RegisterNotificationPush = (
    input: RegistrationInput
) => Promise<{ id: string; version: number }>;
export type RevokeNotificationPush = (input: {
    id: string;
    expectedOrganizationId: string;
    expectedVersion: number;
}) => Promise<unknown>;

export type EnablePushOutcome = Readonly<{
    status:
        | 'enabled'
        | 'registrationRefused'
        | 'enableFailed'
        | 'receiptUnavailable';
    cleanupNeeded: boolean;
    receipt: NotificationPushReceipt | null;
}>;

type PreparedPush = Readonly<{
    input: () => RegistrationInput;
    deviceId: string;
    created: boolean;
    unsubscribe: () => Promise<boolean>;
}>;

function registrationRefused(error: unknown) {
    try {
        if (typeof error !== 'object' || error === null) return false;
        const code = Object.getOwnPropertyDescriptor(error, 'code');
        return (
            code !== undefined &&
            'value' in code &&
            code.value === 'BAD_REQUEST'
        );
    } catch {
        return false;
    }
}

/** Registration failure only rolls back a subscription created by this action. */
export async function enableNotificationPush({
    prepare,
    register,
    writeReceipt,
}: Readonly<{
    prepare: () => Promise<PreparedPush>;
    register: RegisterNotificationPush;
    writeReceipt: (receipt: NotificationPushReceipt) => void;
}>): Promise<EnablePushOutcome> {
    let prepared: PreparedPush | undefined;
    let receipt: NotificationPushReceipt | null = null;
    try {
        prepared = await prepare();
        const registered = await register(prepared.input());
        receipt = {
            id: registered.id,
            version: registered.version,
            deviceId: prepared.deviceId,
        };
        writeReceipt(receipt);
        return { status: 'enabled', cleanupNeeded: true, receipt };
    } catch (error) {
        if (receipt)
            return {
                status: 'receiptUnavailable',
                cleanupNeeded: true,
                receipt,
            };
        let cleanupNeeded = prepared !== undefined;
        if (prepared?.created) {
            try {
                cleanupNeeded = !(await prepared.unsubscribe());
            } catch {
                cleanupNeeded = true;
            }
        }
        return {
            status: registrationRefused(error)
                ? 'registrationRefused'
                : 'enableFailed',
            cleanupNeeded,
            receipt: null,
        };
    }
}

export type DisablePushOutcome = Readonly<{
    status:
        | 'disabled'
        | 'localOnly'
        | 'serverRevokeFailed'
        | 'localCleanupFailed'
        | 'receiptUnavailable';
    cleanupNeeded: boolean;
    receipt: NotificationPushReceipt | null;
    serverRevoked: boolean;
    localRemoved: boolean;
}>;

/**
 * Revokes only the saved user/organization receipt, without registering again.
 * Unknown server outcomes retain that receipt; confirmed revocation is persisted
 * so a browser-cleanup retry need not revoke an obsolete receipt version again.
 */
export async function disableNotificationPush({
    organizationId,
    receipt,
    revoke,
    unsubscribe,
    writeReceipt,
    clearReceipt,
}: Readonly<{
    organizationId: string;
    receipt: NotificationPushReceipt | null;
    revoke: RevokeNotificationPush;
    unsubscribe: () => Promise<boolean | null>;
    writeReceipt: (receipt: NotificationPushReceipt) => void;
    clearReceipt: () => void;
}>): Promise<DisablePushOutcome> {
    let retained = receipt;
    let serverRevoked = receipt?.serverRevoked === true;
    if (receipt && !serverRevoked) {
        try {
            await revoke({
                id: receipt.id,
                expectedOrganizationId: organizationId,
                expectedVersion: receipt.version,
            });
            serverRevoked = true;
            retained = { ...receipt, serverRevoked: true };
            writeReceipt(retained);
        } catch {
            // A failed receipt write must not erase a confirmed server result.
        }
    }
    let localRemoved = false;
    try {
        localRemoved = (await unsubscribe()) === true;
    } catch {
        // Browser refusal and unsupported environments remain partial outcomes.
    }
    if (serverRevoked && localRemoved) {
        try {
            clearReceipt();
            return {
                status: 'disabled',
                cleanupNeeded: false,
                receipt: null,
                serverRevoked,
                localRemoved,
            };
        } catch {
            return {
                status: 'receiptUnavailable',
                cleanupNeeded: true,
                receipt: retained,
                serverRevoked,
                localRemoved,
            };
        }
    }
    const status =
        receipt && !serverRevoked
            ? 'serverRevokeFailed'
            : localRemoved
              ? 'localOnly'
              : 'localCleanupFailed';
    return {
        status,
        cleanupNeeded: retained !== null || !localRemoved,
        receipt: retained,
        serverRevoked,
        localRemoved,
    };
}

/** Covers browser prompts, RPC, storage and local cleanup as one action. */
export function createNotificationPushActionGate() {
    let busy = false;
    return {
        async run<T>(
            action: () => Promise<T>
        ): Promise<{ started: false } | { started: true; value: T }> {
            if (busy) return { started: false };
            busy = true;
            try {
                return { started: true, value: await action() };
            } finally {
                busy = false;
            }
        },
    };
}
