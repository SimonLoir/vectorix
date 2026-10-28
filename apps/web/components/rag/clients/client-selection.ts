import type { CollectionSelection } from '../home/collection-picker';

export type BoundClientSelection = Readonly<{
    organizationId: string;
    collection: CollectionSelection;
}>;
type ReadableCollection = Readonly<{
    id: string;
    permissions: Readonly<{ read: boolean }>;
}>;

/** A remembered collection is never transferred to another organization's connection template. */
export function selectedClientCollection(
    selection: BoundClientSelection | null,
    organizationId: string | null | undefined
) {
    return organizationId && selection?.organizationId === organizationId
        ? selection.collection
        : null;
}

/** Copying requires a matching resource read after current session/permission and request guards. */
export function canCopyClientConfiguration(
    state: Readonly<{
        active: boolean;
        identityReady: boolean;
        permissionsReady: boolean;
        canRead: boolean;
        organizationId: string | null | undefined;
        selection: BoundClientSelection | null;
        collection: ReadableCollection | undefined;
        fetching: boolean;
        failed: boolean;
    }>
) {
    const selected = selectedClientCollection(
        state.selection,
        state.organizationId
    );
    return Boolean(
        state.active &&
        state.identityReady &&
        state.permissionsReady &&
        state.canRead &&
        !state.fetching &&
        !state.failed &&
        selected &&
        state.collection?.id === selected.id &&
        state.collection.permissions.read
    );
}
