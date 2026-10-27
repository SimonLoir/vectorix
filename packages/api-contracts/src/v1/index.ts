import {
    oc,
    type ContractRouterClient,
    type InferContractRouterOutputs,
} from '@orpc/contract';
import { systemV1Contract } from './system';
import { superAdminV1Contract } from './superadmin';
import { adminOrganizationsV1Contract } from './organizations/admin';
import { adminMembersV1Contract } from './members/admin';
import { adminNotificationsV1Contract } from './notifications';
import { ragContract } from './rag';
import { retrievalContract } from './retrieval';
export const v1Contract = {
    ...systemV1Contract,
    retrieval: oc
        .prefix('/retrieval')
        .tag('Retrieval')
        .router(retrievalContract),
    superadmin: oc
        .prefix('/superadmin')
        .tag('Administration')
        .router({
            ...superAdminV1Contract,
            users: oc.prefix('/users').router(superAdminV1Contract.users),
            organizations: oc
                .prefix('/organizations')
                .router(superAdminV1Contract.organizations),
            features: oc
                .prefix('/features')
                .router(superAdminV1Contract.features),
        }),
    admin: oc.prefix('/admin').router({
        rag: oc.prefix('/rag').tag('RAG catalog').router(ragContract),
        organization: oc
            .prefix('/organization')
            .tag('Organizations')
            .router(adminOrganizationsV1Contract),
        members: oc
            .prefix('/members')
            .tag('Members')
            .router(adminMembersV1Contract),
        notifications: oc
            .prefix('/notifications')
            .tag('Notifications')
            .router(adminNotificationsV1Contract),
    }),
};
export type VectorixApiV1Contract = typeof v1Contract;
export type VectorixApiV1Client = ContractRouterClient<VectorixApiV1Contract>;
export type VectorixApiV1Outputs =
    InferContractRouterOutputs<VectorixApiV1Contract>;
