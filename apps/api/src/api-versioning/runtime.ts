import { API_VERSION_REGISTRY } from './registry';
import { createApiVersionRuntime } from './runtime-factory';

/** Runtime handlers paired with their immutable major-version definition. */
export const API_VERSION_RUNTIMES = API_VERSION_REGISTRY.map((version) =>
    createApiVersionRuntime(version)
);

export const CURRENT_API_RUNTIME = API_VERSION_RUNTIMES.find(
    ({ version }) => version.status === 'current'
)!;
