import { Connection } from './connection';
import {
    provisionGeneration,
    dropGeneration,
    analyzeGeneration,
} from './provision';
import {
    openPublication,
    writeBatch,
    sealPublication,
    tombstonePublication,
} from './publications';
import { searchVectors, type SearchInput } from './search';
import type {
    DestinationConfig,
    GenerationSpec,
    PublicationSpec,
    VectorRow,
} from './types';
export * from './types';
export { manifestHash, generationTable, vectorLiteral } from './validation';
export type { SearchInput } from './search';
/** Internal service boundary: authorization, catalog publication and durable task epochs remain in the application database. */
export class VectorStore {
    private connection: Connection;
    constructor(config: DestinationConfig) {
        this.connection = new Connection(config);
    }
    initialize() {
        return this.connection.initialize();
    }
    close() {
        return this.connection.close();
    }
    provision(spec: GenerationSpec) {
        return provisionGeneration(this.connection, spec);
    }
    analyze(spec: GenerationSpec) {
        return analyzeGeneration(this.connection, spec);
    }
    drop(spec: GenerationSpec) {
        return dropGeneration(this.connection, spec);
    }
    open(spec: GenerationSpec, publication: PublicationSpec, epoch: bigint) {
        return openPublication(this.connection, spec, publication, epoch);
    }
    write(
        spec: GenerationSpec,
        publication: PublicationSpec,
        epoch: bigint,
        rows: readonly VectorRow[]
    ) {
        return writeBatch(this.connection, spec, publication, epoch, rows);
    }
    seal(spec: GenerationSpec, publication: PublicationSpec, epoch: bigint) {
        return sealPublication(this.connection, spec, publication, epoch);
    }
    tombstone(spec: GenerationSpec, publication: PublicationSpec) {
        return tombstonePublication(this.connection, spec, publication);
    }
    search(spec: GenerationSpec, input: SearchInput) {
        return searchVectors(this.connection, spec, input);
    }
}
