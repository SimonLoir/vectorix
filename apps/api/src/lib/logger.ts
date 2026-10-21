import pino from 'pino';
export const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    redact: ['headers.authorization', 'headers.cookie', 'password', 'token'],
});
