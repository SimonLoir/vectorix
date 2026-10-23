# Server mail

`@repo/emails` provides `assertSystemMailConfigured()` and
`sendSystemMail(to, subject, html)` for password reset, account-security callbacks
and system notifications. Configuration is resolved from current server
environment values on every call. Neither configuration preflight nor module
import contacts a provider. These functions must remain on the server; resolved
credentials must never be serialized to a client or logged.

The shared [resolver](src/system-mail-configuration.ts) selects a nonempty
`VECTORIX_DEFAULT_RESEND_API_KEY` before SMTP. An invalid selected configuration
does not fall back to another provider. The API key and SMTP credentials retain
their original bytes. A whitespace-only selected Resend key is invalid.

Without a Resend key, SMTP requires `VECTORIX_DEFAULT_SMTP_HOST`. An absent or
blank `VECTORIX_DEFAULT_SMTP_PORT` uses 587; an explicit port must be a decimal
integer from 1 through 65535. SMTP authentication is optional: configure both
`VECTORIX_DEFAULT_SMTP_USER` and `VECTORIX_DEFAULT_SMTP_PASSWORD`, or neither.
Partial authentication fails preflight. Empty credential strings count as absent;
a nonempty password, including significant outer spaces, is preserved.

The chosen provider uses only its own sender variable:
`VECTORIX_DEFAULT_RESEND_SENDER_EMAIL` or
`VECTORIX_DEFAULT_SMTP_SENDER_EMAIL`. An absent or blank sender retains the
compatibility default `noreply@example.com`; operators should configure a sender
accepted by their provider. The other provider's sender is never borrowed.
Configured sender control characters are refused.

[System delivery](src/system-mail.ts) uses implicit SMTP TLS on port 465 and the
existing Nodemailer negotiation behavior on other ports. Connection and socket
timeouts are 10 and 30 seconds; these are transport timeouts, not an overall
delivery deadline. Successful completion means the transport accepted the send,
not that a recipient received or read it. Provider failure produces a static
`SystemMailError` without a raw response or cause. There is no automatic retry or
provider fallback at this boundary. Notification workers retain their existing
durable delivery retries and sanitized failure state.

Auth callers keep canonical link validation and localized message construction
in `@repo/auth`. Preflight can reject static configuration before account/token
work; it does not establish connectivity or make native token work and email
delivery atomic. Better Auth may swallow callback errors, so UI messages must
not promise confirmed delivery. Password reset independently revalidates its
configured canonical URL before calling this shared sender.

[Focused unit tests](src/system-mail.test.ts) cover provider precedence, raw
secrets, sender isolation, SMTP validation, shared preflight/delivery behavior
and sanitized single-attempt failures. Their transport boundary is mocked; they
do not establish live SMTP or Resend acceptance.
