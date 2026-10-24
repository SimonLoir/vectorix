import type { PrismaClient } from '@repo/db';
import { checked, mergeDelta, validTags } from './numeric';
import { telemetryExecution } from './execution';
import {
    persistLanes,
    persistTelemetry,
    pruneTelemetry,
    type LaneWrite,
    type ScanStart,
} from './write';
import type {
    TelemetryDelta,
    TelemetryTags,
    TelemetryScan,
    WorkerLane,
} from './types';

type Buffered = {
    tags: TelemetryTags;
    delta: TelemetryDelta;
    sequence: bigint;
};
type Gap = { organizationId: string; sequence: bigint };
type LaneSlot = {
    heartbeat: boolean;
    start?: ScanStart;
    finish?: LaneWrite['finish'];
};
export interface TelemetryPersistence {
    write(entries: readonly Buffered[], gaps: readonly Gap[]): Promise<void>;
    lanes(values: readonly LaneWrite[]): Promise<void>;
    prune(): Promise<void>;
}

/** Process-local numeric coalescer: 256 deltas including detached keys, 256 gaps and three lane slots. */
export class RagTelemetryRecorder {
    private readonly deltas = new Map<string, Buffered>();
    private readonly gaps = new Map<string, Gap>();
    private readonly lanes: Record<WorkerLane, LaneSlot> = {
        NOTIFICATIONS: { heartbeat: false },
        DOCUMENTS: { heartbeat: false },
        INDEXING: { heartbeat: false },
    };
    private detached = 0;
    private detachedGaps = 0;
    private sequence = 0n;
    private writing: Promise<void> | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private stopped = false;

    private readonly persistence: TelemetryPersistence;

    constructor(db: PrismaClient | TelemetryPersistence) {
        this.persistence =
            'write' in db
                ? db
                : {
                      write: (entries, gaps) =>
                          persistTelemetry(db, entries, gaps),
                      lanes: (values) => persistLanes(db, values),
                      prune: () => pruneTelemetry(db),
                  };
    }

    private gap(organizationId: string) {
        if (
            !this.gaps.has(organizationId) &&
            this.gaps.size + this.detachedGaps < 256
        )
            this.gaps.set(organizationId, {
                organizationId,
                sequence: this.sequence++,
            });
    }

    /** No I/O or promise allocation. Invalid/overflow observations are gaps, never domain failures. */
    observe(tags: TelemetryTags, delta: TelemetryDelta) {
        if (this.stopped || !validTags(tags)) return;
        try {
            const key = JSON.stringify([
                tags.organizationId,
                tags.workload,
                tags.provider,
            ]);
            const existing = this.deltas.get(key);
            if (!existing && this.deltas.size + this.detached >= 256) {
                this.gap(tags.organizationId);
                return;
            }
            const merged = mergeDelta(tags, existing?.delta ?? {}, delta);
            this.deltas.set(key, {
                tags: Object.freeze({ ...tags }),
                delta: merged,
                sequence: existing?.sequence ?? this.sequence++,
            });
        } catch {
            this.gap(tags.organizationId);
        }
    }

    /** Synchronous execution handle; only exact saved profile tags may be supplied. */
    start(tags: TelemetryTags, startedAt?: number) {
        return telemetryExecution(
            tags,
            (delta) => this.observe(tags, delta),
            startedAt
        );
    }

    heartbeat(lane: WorkerLane) {
        if (!this.stopped) this.lanes[lane].heartbeat = true;
    }

    /** A lost scan-start observation cannot prevent a scan; receipt may honestly remain NULL. */
    startScan(lane: WorkerLane): TelemetryScan {
        const started = performance.now();
        const start: ScanStart = { receipt: null };
        if (!this.stopped) this.lanes[lane].start = start;
        let finished = false;
        return {
            finish: (outcome, failure = 'UNKNOWN') => {
                if (finished || this.stopped) return;
                finished = true;
                this.lanes[lane].finish = {
                    start,
                    durationMicros: checked(
                        BigInt(
                            Math.max(
                                0,
                                Math.round((performance.now() - started) * 1000)
                            )
                        )
                    ),
                    outcome,
                    failure:
                        outcome === 'RETURNED' ? null : (failure ?? 'UNKNOWN'),
                };
            },
        };
    }

    /** Idempotent unref timer, with no queued flushes when a writer is already in flight. */
    startTimer() {
        if (!this.timer && !this.stopped) {
            this.timer = setInterval(() => {
                void this.flush();
            }, 5000);
            this.timer.unref();
        }
        return this;
    }

    private async cycle() {
        const started = performance.now();
        const laneBatch: LaneWrite[] = [];
        for (const lane of [
            'NOTIFICATIONS',
            'DOCUMENTS',
            'INDEXING',
        ] as const) {
            const value = this.lanes[lane];
            if (value.heartbeat || value.start || value.finish) {
                laneBatch.push({ lane, ...value });
                this.lanes[lane] = { heartbeat: false };
            }
        }
        let transactions = 0;
        if (laneBatch.length) {
            transactions++;
            await this.persistence.lanes(laneBatch).catch(() => {});
        }
        // Leave 50ms pool wait + 250ms transaction budget inside the one-second cycle ceiling.
        while (transactions < 4 && performance.now() - started < 700) {
            const candidates = [
                ...[...this.deltas].map(([key, value]) => ({
                    kind: 'delta' as const,
                    key,
                    value,
                })),
                ...[...this.gaps].map(([key, value]) => ({
                    kind: 'gap' as const,
                    key,
                    value,
                })),
            ]
                .toSorted((a, b) =>
                    a.value.sequence < b.value.sequence ? -1 : 1
                )
                .slice(0, 16);
            if (!candidates.length) break;
            const entries: Buffered[] = [],
                gaps: Gap[] = [];
            for (const candidate of candidates) {
                if (candidate.kind === 'delta') {
                    this.deltas.delete(candidate.key);
                    entries.push(candidate.value);
                } else {
                    this.gaps.delete(candidate.key);
                    gaps.push(candidate.value);
                }
            }
            this.detached = entries.length;
            this.detachedGaps = gaps.length;
            transactions++;
            let failed = false;
            try {
                await this.persistence.write(
                    entries.toSorted((a, b) =>
                        JSON.stringify(a.tags).localeCompare(
                            JSON.stringify(b.tags)
                        )
                    ),
                    gaps.toSorted((a, b) =>
                        a.organizationId.localeCompare(b.organizationId)
                    )
                );
            } catch {
                failed = true;
            } finally {
                this.detached = 0;
                this.detachedGaps = 0;
            }
            // Never replay an unconfirmed write. A surviving process can report only a bounded gap.
            if (failed) {
                for (const organizationId of new Set([
                    ...entries.map((entry) => entry.tags.organizationId),
                    ...gaps.map((gap) => gap.organizationId),
                ]))
                    this.gap(organizationId);
                break; // Report on a later cycle; do not spin on an unavailable recorder.
            }
        }
    }

    /** At most four bounded transactions per cycle; concurrent callers share one writer, not a queue. */
    flush(): Promise<void> {
        if (this.writing) return this.writing;
        this.writing = this.cycle()
            .catch(() => {})
            .finally(() => {
                this.writing = null;
            });
        return this.writing;
    }

    /** One bounded maintenance pass, skipped during another write; no task/accounting locks. */
    async prune() {
        if (this.writing) return;
        this.writing = this.persistence
            .prune()
            .catch(() => {})
            .finally(() => {
                this.writing = null;
            });
        await this.writing;
    }

    /** Bounded best-effort final cycle; process death/unflushed tail remains explicitly unknown. */
    async shutdown() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.stopped = true;
        await this.flush();
    }
}
