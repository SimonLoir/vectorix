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

export const ragRouter = authorized
    .prefix('/rag')
    .tag('RAG catalog')
    .router({
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
        documents: { list: listDocuments, get: getDocument },
        connections: listConnections,
        quota: getQuota,
        audit: listAudit,
    });
