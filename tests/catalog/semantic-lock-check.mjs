import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// Test-only SQL proves the reviewed trigger locking protocol; production access
// uses Prisma. This fixture never loads .env or accepts an application database.
const connectionString = process.env.DATABASE_URL;
if (
    !connectionString ||
    !/^vectorix_(catalog|semantic_schema)_test$/.test(
        new URL(connectionString).pathname.slice(1)
    )
) {
    throw new Error(
        'Semantic lock checks require an owned disposable test database.'
    );
}
const require = createRequire(
    new URL('../../packages/db/package.json', import.meta.url)
);
const { Client } = require('pg');
const admin = new Client({ connectionString });
const writer = new Client({ connectionString });
const remover = new Client({ connectionString });
const fixture = await readFile(
    new URL('./semantic-schema-check.sql', import.meta.url),
    'utf8'
);
const setup =
    'BEGIN;\n' +
    fixture.slice(
        fixture.indexOf('INSERT INTO "user"'),
        fixture.indexOf('INSERT INTO "SemanticChunkPlan"')
    ) +
    '\nCOMMIT;';
const workInsert = `INSERT INTO "EmbeddingWorkAttempt" (id,"organizationId","generationId","indexedDocumentId",purpose,"operationKey","batchOrdinal","attemptNumber","inputHash","inputCount","preparedInputBytes","taskId","leaseEpoch",state,"reservedPreparedBytes","reservedBatches","dispatchedPreparedBytes","dispatchedBatches","dispatchStartedAt","deadlineAt","updatedAt")
VALUES ('semantic-lock-attempt','semantic-schema-org','00000000-0000-4000-8000-000000000081','semantic-schema-candidate','BOUNDARY','synthetic-lock-operation',0,1,repeat('a',64),2,12,'diagnostic-lock-task',1,'IN_FLIGHT',12,1,12,1,now(),now()+interval '120 seconds',now())`;

async function waitForBlocked(client) {
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid;
    return async () => {
        for (let attempt = 0; attempt < 200; attempt++) {
            const result = await admin.query(
                "SELECT wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0 AS blocked FROM pg_stat_activity WHERE pid = $1",
                [pid]
            );
            if (result.rows[0]?.blocked) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.fail(
            'The semantic organization admission must visibly wait on the competing transaction.'
        );
    };
}
async function cleanup() {
    await Promise.allSettled([
        writer.query('ROLLBACK'),
        remover.query('ROLLBACK'),
    ]);
    await admin.query(
        `UPDATE "EmbeddingWorkAttempt" SET state='UNCERTAIN',"reservedPreparedBytes"=0,"reservedBatches"=0,"uncertainAt"=now(),"settledAt"=now(),"outcomeCode"='PROVIDER_TIMEOUT' WHERE id='semantic-lock-attempt' AND state='IN_FLIGHT'`
    );
    await admin.query(
        "DELETE FROM organization WHERE id='semantic-schema-org'"
    );
    await admin.query('DELETE FROM "user" WHERE id=\'semantic-schema-user\'');
}
try {
    await Promise.all([admin.connect(), writer.connect(), remover.connect()]);
    // Deletion wins: a late descendant must wait and fail, not survive the cascade.
    await admin.query(setup);
    const insertionBlocked = await waitForBlocked(writer);
    await remover.query('BEGIN');
    await remover.query(
        "DELETE FROM organization WHERE id='semantic-schema-org'"
    );
    await writer.query('BEGIN');
    const inserting = writer.query(workInsert);
    void inserting.catch(() => {});
    try {
        await insertionBlocked();
        await remover.query('COMMIT');
        await assert.rejects(inserting, { code: '23503' });
        await writer.query('ROLLBACK');
        assert.equal(
            (
                await admin.query(
                    'SELECT count(*)::integer AS count FROM "EmbeddingWorkAttempt" WHERE id=\'semantic-lock-attempt\''
                )
            ).rows[0].count,
            0
        );
    } finally {
        await cleanup();
    }
    // Accepted work wins: native-shaped members-first deletion must wait, reject
    // actual IN_FLIGHT work without cached accounting, and restore membership.
    await admin.query(setup);
    const deletionBlocked = await waitForBlocked(remover);
    await writer.query('BEGIN');
    await writer.query(workInsert);
    await remover.query('BEGIN');
    await remover.query(
        'DELETE FROM member WHERE "organizationId"=\'semantic-schema-org\''
    );
    const deleting = remover.query(
        "DELETE FROM organization WHERE id='semantic-schema-org'"
    );
    void deleting.catch(() => {});
    try {
        await deletionBlocked();
        await writer.query('COMMIT');
        await assert.rejects(deleting, {
            code: '23514',
            constraint: 'organization_rag_cleanup_required',
        });
        await remover.query('ROLLBACK');
        assert.equal(
            (
                await admin.query(
                    "SELECT count(*)::integer AS count FROM member WHERE id='semantic-schema-member'"
                )
            ).rows[0].count,
            1
        );
        assert.equal(
            (
                await admin.query(
                    "SELECT count(*)::integer AS count FROM organization WHERE id='semantic-schema-org'"
                )
            ).rows[0].count,
            1
        );
    } finally {
        await cleanup();
    }
    console.log(
        'Semantic PostgreSQL key-share races: 2 passed; members-first rollback preserved.'
    );
} finally {
    await Promise.allSettled([
        writer.query('ROLLBACK'),
        remover.query('ROLLBACK'),
    ]);
    await Promise.allSettled([writer.end(), remover.end(), admin.end()]);
}
