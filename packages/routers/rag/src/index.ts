import { sourcePreviewDocumentHandler } from './documents/sourcePreview';
import { modelsIndexHandler } from './indexing/models';
import { probeIndexHandler } from './indexing/probe';
import { startIndexHandler } from './indexing/start';
import { rebuildIndexHandler } from './indexing/rebuild';
import { discardIndexHandler } from './indexing/discard';
import { statusIndexHandler } from './indexing/status';
import { tasksIndexHandler } from './indexing/tasks';
import { retryIndexHandler } from './indexing/retry';
import { adoptSynchronizationHandler } from './indexing/adoptSynchronization';
import { documentsIndexHandler } from './indexing/documents';
import { updateMetadataIndexHandler } from './indexing/updateMetadata';
import { chunksIndexHandler } from './indexing/chunks';
import { searchIndexHandler } from './indexing/search';
import { sourcePreviewIndexHandler } from './indexing/sourcePreview';
import { sourceOriginalIndexHandler } from './indexing/sourceOriginal';
import { trashIndexHandler } from './indexing/trash';
import { replaceDocumentHandler } from './documents/replace';
import { deleteDocumentHandler } from './documents/delete';
import { lifecycleDocumentHandler } from './documents/lifecycle';
import { trashDocumentHandler } from './documents/trash';
import { retryCleanupDocumentHandler } from './documents/retryCleanup';
import { uploadDocumentHandler } from './documents/upload';
import { detailsDocumentHandler } from './documents/details';
import { previewDocumentHandler } from './documents/preview';
import { downloadDocumentHandler } from './documents/download';
import { retryDocumentHandler } from './documents/retry';
import { collectionCandidatesDocumentHandler } from './documents/collectionCandidates';
import { setCollectionDocumentHandler } from './documents/setCollection';
import { authorized } from '@routers/utils/authorized';
import { listCredentials } from './credentials/list';
import { createCredentialHandler } from './credentials/create';
import { updateCredentialHandler } from './credentials/update';
import { activateCredentialHandler } from './credentials/activate';
import { deleteCredentialHandler } from './credentials/delete';
import { listGroups } from './groups/list';
import { listGroupMembers } from './groups/members';
import { createGroupHandler } from './groups/create';
import { renameGroupHandler } from './groups/rename';
import { deleteGroupHandler } from './groups/delete';
import { addMemberGroupHandler } from './groups/addMember';
import { removeMemberGroupHandler } from './groups/removeMember';
import { listCollections } from './collections/list';
import { getCollection } from './collections/get';
import { createCollectionHandler } from './collections/create';
import { updateCollectionHandler } from './collections/update';
import { deleteCollectionHandler } from './collections/delete';
import { listCollectionGrants } from './collections/grants';
import { setGrantHandler } from './collections/setGrant';
import { removeGrantHandler } from './collections/removeGrant';
import { listDocuments } from './documents/list';
import { getDocument } from './documents/get';
import { listConnections } from './connections';
import { getQuota } from './quota';
import { listAudit } from './audit';
import { listRevisions } from './collections/revisions';
import { listGrantCandidates } from './collections/grantCandidates';
import { listMemberCandidates } from './groups/memberCandidates';
import { operationsOverviewHandler } from './operations/overview';

export const ragRouter = authorized
    .prefix('/rag')
    .tag('RAG catalog')
    .router({
        operations: { overview: operationsOverviewHandler },
        indexing: {
            models: modelsIndexHandler,
            probe: probeIndexHandler,
            start: startIndexHandler,
            rebuild: rebuildIndexHandler,
            discard: discardIndexHandler,
            status: statusIndexHandler,
            tasks: tasksIndexHandler,
            retry: retryIndexHandler,
            adoptSynchronization: adoptSynchronizationHandler,
            documents: documentsIndexHandler,
            updateMetadata: updateMetadataIndexHandler,
            chunks: chunksIndexHandler,
            search: searchIndexHandler,
            sourcePreview: sourcePreviewIndexHandler,
            sourceOriginal: sourceOriginalIndexHandler,
            trash: trashIndexHandler,
        },
        credentials: {
            list: listCredentials,
            create: createCredentialHandler,
            update: updateCredentialHandler,
            activate: activateCredentialHandler,
            delete: deleteCredentialHandler,
        },
        groups: {
            memberCandidates: listMemberCandidates,
            list: listGroups,
            create: createGroupHandler,
            rename: renameGroupHandler,
            delete: deleteGroupHandler,
            members: listGroupMembers,
            addMember: addMemberGroupHandler,
            removeMember: removeMemberGroupHandler,
        },
        collections: {
            revisions: listRevisions,
            grantCandidates: listGrantCandidates,
            list: listCollections,
            get: getCollection,
            create: createCollectionHandler,
            update: updateCollectionHandler,
            delete: deleteCollectionHandler,
            grants: listCollectionGrants,
            setGrant: setGrantHandler,
            removeGrant: removeGrantHandler,
        },
        documents: {
            sourcePreview: sourcePreviewDocumentHandler,
            replace: replaceDocumentHandler,
            delete: deleteDocumentHandler,
            lifecycle: lifecycleDocumentHandler,
            trash: trashDocumentHandler,
            retryCleanup: retryCleanupDocumentHandler,
            list: listDocuments,
            get: getDocument,
            upload: uploadDocumentHandler,
            details: detailsDocumentHandler,
            preview: previewDocumentHandler,
            download: downloadDocumentHandler,
            retry: retryDocumentHandler,
            collectionCandidates: collectionCandidatesDocumentHandler,
            setCollection: setCollectionDocumentHandler,
        },
        connections: listConnections,
        quota: getQuota,
        audit: listAudit,
    });
