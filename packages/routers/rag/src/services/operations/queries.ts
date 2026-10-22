import { Prisma } from '@repo/db';
import type { RagActor } from '../access';
import { operationAccess } from './access';
import { categorySource, currentWork } from './current-work';
import type { OperationCategory, OperationsInput } from './types';

function stateAt(observedAt: Date) {
    return Prisma.sql`CASE WHEN task.status::text='UPLOADING' THEN 'UPLOADING'
        WHEN task.status::text='FAILED' THEN 'FAILED'
        WHEN task.status::text='PENDING' THEN CASE WHEN task."availableAt"<=${observedAt} THEN 'DUE' ELSE 'SCHEDULED' END
        WHEN task."leasedUntil">${observedAt} THEN 'LEASED' ELSE 'EXPIRED' END`;
}

/** Reused by summary, visible total and page so current-work classification cannot diverge. */
export function workRows(
    organizationId: string,
    category: OperationCategory,
    observedAt: Date,
    actor?: RagActor
) {
    const id =
        category === 'INDEXING'
            ? Prisma.sql`task.id`
            : Prisma.sql`task."versionId"`;
    const kind =
        category === 'INDEXING'
            ? Prisma.sql`task.kind::text`
            : Prisma.sql`${category}::text`;
    const version =
        category === 'INDEXING'
            ? Prisma.sql`NULL::integer`
            : Prisma.sql`version.version`;
    return Prisma.sql`SELECT ${id} AS id, ${category}::text AS category, ${kind} AS kind,
        task.status::text AS status, ${stateAt(observedAt)} AS state, target.name AS name, ${version} AS version,
        task."createdAt",task."updatedAt",task."availableAt",task."leasedUntil",task.attempts,task."errorCode",
        target.id AS "targetId",(target."deletedAt" IS NOT NULL) AS deleted
        FROM ${categorySource(category)} WHERE task."organizationId"=${organizationId} AND ${currentWork(category)}
        ${actor ? Prisma.sql`AND (${operationAccess(actor, category)})` : Prisma.empty}`;
}

/** Literal substring search matches the existing authorized target name, never raw task diagnostics. */
export function literalSearch(query: string) {
    return query.replaceAll(/[\\%_]/g, String.raw`\$&`);
}

export function pageFilter(input: OperationsInput) {
    const query = `%${literalSearch(input.query)}%`;
    return Prisma.sql`name ILIKE ${query} ${input.state === 'ALL' ? Prisma.empty : Prisma.sql`AND state=${input.state}`}`;
}

/** A final, bounded ACL-only check does not turn ordinary task completion into a permission failure. */
export function visiblePageIds(
    actor: RagActor,
    category: OperationCategory,
    ids: string[]
) {
    const id =
        category === 'INDEXING'
            ? Prisma.sql`task.id`
            : Prisma.sql`task."versionId"`;
    return Prisma.sql`SELECT ${id} AS id FROM ${categorySource(category)}
        WHERE task."organizationId"=${actor.organizationId} AND ${id} IN (${Prisma.join(ids)})
            AND (${operationAccess(actor, category)})`;
}
