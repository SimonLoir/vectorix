export { default as MailService } from './MailService';
export { sendSystemMail, escapeHtml } from './system-mail';
export {
    assertSystemMailConfigured,
    resolveSystemMailConfiguration,
    SystemMailError,
} from './system-mail-configuration';
export type {
    SystemMailConfiguration,
    SystemMailEnvironment,
} from './system-mail-configuration';
