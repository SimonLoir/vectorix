/** Probe built entry points with synthetic configuration; intercept all socket I/O. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const [service, entry, extra] = process.argv.slice(2);
assert.ok(
    ['api', 'workers'].includes(service) && entry && !extra,
    'Expected service and built entry path.'
);
const networkMarker = 'VECTORIX_STARTUP_NETWORK_ATTEMPT';
const preload =
    'data:text/javascript,' +
    encodeURIComponent(`
    import net from 'node:net';
    import tls from 'node:tls';
    import { syncBuiltinESMExports } from 'node:module';
    const deny = () => {
        process.stderr.write('${networkMarker}\\n');
        process.exit(73);
    };
    net.connect = deny;
    net.createConnection = deny;
    net.Socket.prototype.connect = deny;
    net.Server.prototype.listen = deny;
    tls.connect = deny;
    syncBuiltinESMExports();
`);
const valid = {
    NODE_ENV: 'production',
    DATABASE_URL:
        'postgresql://startup_probe:synthetic@127.0.0.1:1/vectorix_startup_config_test',
    REDIS_URL: 'redis://127.0.0.1:1/15',
    BETTER_AUTH_SECRET: 'startup-probe-synthetic-secret-at-least-32-characters',
    ENCRYPTION_SECRET: '0123456789abcdef'.repeat(4),
    BETTER_AUTH_URL: 'http://api.example.test',
    TRUSTED_ORIGINS: 'http://web.example.test',
    VECTORIX_WEB_URL: 'http://web.example.test',
    VECTORIX_WEB_PUSH_ENABLED: 'false',
};
/** The child receives no inherited environment, application data or credentials. */
function execute(args, changes = {}) {
    const result = spawnSync(process.execPath, ['--import', preload, ...args], {
        env: { ...valid, ...changes },
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 256 * 1024,
    });
    assert.equal(
        result.error,
        undefined,
        'The bounded startup child must terminate normally.'
    );
    assert.equal(
        result.signal,
        null,
        'The startup child must not time out or need termination.'
    );
    return result;
}
const control = execute([
    '--eval',
    'new (require("node:net").Socket)().connect(1, "127.0.0.1")',
]);
assert.equal(control.status, 73);
assert.ok(
    control.stderr.includes(networkMarker),
    'The network interception must be live.'
);

const cases = [
    { variable: 'ENCRYPTION_SECRET', value: ` ${valid.ENCRYPTION_SECRET} ` },
    ...(service === 'api'
        ? [
              {
                  variable: 'BETTER_AUTH_SECRET',
                  value: 'replace-with-a-random-secret-at-least-32-characters',
              },
              { variable: 'TRUSTED_ORIGINS', value: ',' },
          ]
        : [
              { variable: 'VECTORIX_WEB_URL', value: '' },
              {
                  variable: 'VECTORIX_WEB_URL',
                  value: 'https://private-user:private-password@private-config.example.test',
              },
          ]),
];
for (const { variable, value } of cases) {
    const result = execute([resolve(entry)], { [variable]: value });
    assert.equal(
        result.status,
        1,
        `${service} must reject invalid ${variable} before socket I/O.`
    );
    assert.equal(
        result.stdout,
        '',
        'Configuration rejection must precede runtime startup output.'
    );
    assert.ok(
        result.stderr.includes(
            `Invalid ${service} configuration; refusing to start:`
        )
    );
    assert.ok(result.stderr.includes(variable));
    assert.ok(
        !result.stderr.includes(networkMarker),
        'No socket may be attempted before rejection.'
    );
    if (value.trim().length >= 8)
        assert.ok(
            !result.stderr.includes(value.trim()),
            'Configuration values must remain private.'
        );
}
// The same built entry with valid synthetic configuration must get past the
// preflight and reach the intercepted infrastructure boundary, without I/O.
const accepted = execute([resolve(entry)]);
assert.equal(
    accepted.status,
    73,
    'Valid configuration must reach the real runtime infrastructure boundary.'
);
assert.ok(accepted.stderr.includes(networkMarker));
console.log(
    `${service}: ${cases.length} invalid configurations rejected before socket I/O; valid startup reaches the intercepted boundary.`
);
