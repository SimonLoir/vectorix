-- CreateEnum
CREATE TYPE "CredentialProvider" AS ENUM ('S3', 'OLLAMA', 'COHERE', 'VOYAGE');

-- CreateEnum
CREATE TYPE "ChunkingStrategy" AS ENUM ('TOKEN_WINDOW', 'DOCUMENT_STRUCTURE', 'SEMANTIC');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'DELETED');

-- CreateTable
CREATE TABLE "Credentials" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "CredentialProvider" NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "S3Credentials" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "forcePathStyle" BOOLEAN NOT NULL DEFAULT true,
    "accessKeyId" TEXT NOT NULL,
    "secretAccessKey" TEXT NOT NULL,

    CONSTRAINT "S3Credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OllamaCredentials" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "apiKey" TEXT,

    CONSTRAINT "OllamaCredentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CohereCredentials" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,

    CONSTRAINT "CohereCredentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoyageCredentials" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,

    CONSTRAINT "VoyageCredentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CredentialSelection" (
    "organizationId" TEXT NOT NULL,
    "provider" "CredentialProvider" NOT NULL,
    "credentialId" TEXT NOT NULL,

    CONSTRAINT "CredentialSelection_pkey" PRIMARY KEY ("organizationId","provider")
);

-- CreateTable
CREATE TABLE "StorageLocation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "credentialId" TEXT,
    "fingerprint" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "forcePathStyle" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VectorConnection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL DEFAULT 'platform',
    "name" TEXT NOT NULL DEFAULT 'Platform PostgreSQL',
    "schema" TEXT NOT NULL DEFAULT 'vector_collections',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VectorConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Collection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "configurationRevision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionConfigRevision" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "vectorConnectionId" TEXT NOT NULL,
    "credentialId" TEXT,
    "credentialRevision" INTEGER,
    "provider" "CredentialProvider" NOT NULL,
    "model" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "metric" TEXT NOT NULL DEFAULT 'cosine',
    "indexType" TEXT NOT NULL DEFAULT 'DISKANN',
    "numericType" TEXT NOT NULL DEFAULT 'float32',
    "endpoint" TEXT NOT NULL,
    "preparation" TEXT NOT NULL DEFAULT '',
    "chunkingStrategy" "ChunkingStrategy" NOT NULL DEFAULT 'DOCUMENT_STRUCTURE',
    "chunking" JSONB NOT NULL,
    "parentChild" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionConfigRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationGroup" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMember" (
    "organizationId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,

    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("groupId","memberId")
);

-- CreateTable
CREATE TABLE "CollectionMemberGrant" (
    "organizationId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "manageDocuments" BOOLEAN NOT NULL DEFAULT false,
    "administer" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CollectionMemberGrant_pkey" PRIMARY KEY ("collectionId","memberId")
);

-- CreateTable
CREATE TABLE "CollectionGroupGrant" (
    "organizationId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "manageDocuments" BOOLEAN NOT NULL DEFAULT false,
    "administer" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CollectionGroupGrant_pkey" PRIMARY KEY ("collectionId","groupId")
);

-- CreateTable
CREATE TABLE "ApiKeyPrincipal" (
    "keyId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,

    CONSTRAINT "ApiKeyPrincipal_pkey" PRIMARY KEY ("keyId")
);

-- CreateTable
CREATE TABLE "ApiKeyCollectionScope" (
    "organizationId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "manageDocuments" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ApiKeyCollectionScope_pkey" PRIMARY KEY ("keyId","collectionId")
);

-- CreateTable
CREATE TABLE "OrganizationQuota" (
    "organizationId" TEXT NOT NULL,
    "collections" INTEGER NOT NULL DEFAULT 20,
    "documents" INTEGER NOT NULL DEFAULT 5000,
    "originalBytes" BIGINT NOT NULL,
    "storageBytes" BIGINT NOT NULL,
    "chunksPerCollection" INTEGER NOT NULL DEFAULT 100000,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationQuota_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "RagAuditLog" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RagAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentVersion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "storageLocationId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byteSize" BIGINT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentExtraction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "storageLocationId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "byteSize" BIGINT NOT NULL,
    "extractorVersion" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentExtraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionDocument" (
    "organizationId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionDocument_pkey" PRIMARY KEY ("collectionId","documentId")
);

-- CreateIndex
CREATE INDEX "Credentials_organizationId_createdAt_id_idx" ON "Credentials"("organizationId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Credentials_organizationId_id_key" ON "Credentials"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Credentials_organizationId_id_provider_key" ON "Credentials"("organizationId", "id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "Credentials_organizationId_provider_name_key" ON "Credentials"("organizationId", "provider", "name");

-- CreateIndex
CREATE UNIQUE INDEX "StorageLocation_organizationId_id_key" ON "StorageLocation"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "StorageLocation_organizationId_fingerprint_key" ON "StorageLocation"("organizationId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "VectorConnection_organizationId_id_key" ON "VectorConnection"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "VectorConnection_organizationId_key_key" ON "VectorConnection"("organizationId", "key");

-- CreateIndex
CREATE INDEX "Collection_organizationId_deletedAt_createdAt_id_idx" ON "Collection"("organizationId", "deletedAt", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Collection_organizationId_id_key" ON "Collection"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionConfigRevision_organizationId_collectionId_revisi_key" ON "CollectionConfigRevision"("organizationId", "collectionId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationGroup_organizationId_id_key" ON "OrganizationGroup"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationGroup_organizationId_name_key" ON "OrganizationGroup"("organizationId", "name");

-- CreateIndex
CREATE INDEX "GroupMember_organizationId_memberId_idx" ON "GroupMember"("organizationId", "memberId");

-- CreateIndex
CREATE INDEX "CollectionMemberGrant_organizationId_memberId_idx" ON "CollectionMemberGrant"("organizationId", "memberId");

-- CreateIndex
CREATE INDEX "CollectionGroupGrant_organizationId_groupId_idx" ON "CollectionGroupGrant"("organizationId", "groupId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyPrincipal_organizationId_keyId_key" ON "ApiKeyPrincipal"("organizationId", "keyId");

-- CreateIndex
CREATE INDEX "RagAuditLog_organizationId_createdAt_id_idx" ON "RagAuditLog"("organizationId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "Document_organizationId_deletedAt_createdAt_id_idx" ON "Document"("organizationId", "deletedAt", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Document_organizationId_id_key" ON "Document"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_organizationId_id_key" ON "DocumentVersion"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_organizationId_documentId_version_key" ON "DocumentVersion"("organizationId", "documentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_storageLocationId_objectKey_key" ON "DocumentVersion"("storageLocationId", "objectKey");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentExtraction_versionId_key" ON "DocumentExtraction"("versionId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentExtraction_organizationId_versionId_key" ON "DocumentExtraction"("organizationId", "versionId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentExtraction_storageLocationId_objectKey_key" ON "DocumentExtraction"("storageLocationId", "objectKey");

-- CreateIndex
CREATE INDEX "CollectionDocument_organizationId_documentId_idx" ON "CollectionDocument"("organizationId", "documentId");

-- AddForeignKey
ALTER TABLE "Credentials" ADD CONSTRAINT "Credentials_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "S3Credentials" ADD CONSTRAINT "S3Credentials_id_fkey" FOREIGN KEY ("id") REFERENCES "Credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OllamaCredentials" ADD CONSTRAINT "OllamaCredentials_id_fkey" FOREIGN KEY ("id") REFERENCES "Credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CohereCredentials" ADD CONSTRAINT "CohereCredentials_id_fkey" FOREIGN KEY ("id") REFERENCES "Credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoyageCredentials" ADD CONSTRAINT "VoyageCredentials_id_fkey" FOREIGN KEY ("id") REFERENCES "Credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CredentialSelection" ADD CONSTRAINT "CredentialSelection_organizationId_credentialId_provider_fkey" FOREIGN KEY ("organizationId", "credentialId", "provider") REFERENCES "Credentials"("organizationId", "id", "provider") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageLocation" ADD CONSTRAINT "StorageLocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageLocation" ADD CONSTRAINT "StorageLocation_organizationId_credentialId_fkey" FOREIGN KEY ("organizationId", "credentialId") REFERENCES "Credentials"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VectorConnection" ADD CONSTRAINT "VectorConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionConfigRevision" ADD CONSTRAINT "CollectionConfigRevision_organizationId_collectionId_fkey" FOREIGN KEY ("organizationId", "collectionId") REFERENCES "Collection"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionConfigRevision" ADD CONSTRAINT "CollectionConfigRevision_organizationId_vectorConnectionId_fkey" FOREIGN KEY ("organizationId", "vectorConnectionId") REFERENCES "VectorConnection"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionConfigRevision" ADD CONSTRAINT "CollectionConfigRevision_organizationId_credentialId_fkey" FOREIGN KEY ("organizationId", "credentialId") REFERENCES "Credentials"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationGroup" ADD CONSTRAINT "OrganizationGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_organizationId_groupId_fkey" FOREIGN KEY ("organizationId", "groupId") REFERENCES "OrganizationGroup"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_organizationId_memberId_fkey" FOREIGN KEY ("organizationId", "memberId") REFERENCES "member"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionMemberGrant" ADD CONSTRAINT "CollectionMemberGrant_organizationId_collectionId_fkey" FOREIGN KEY ("organizationId", "collectionId") REFERENCES "Collection"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionMemberGrant" ADD CONSTRAINT "CollectionMemberGrant_organizationId_memberId_fkey" FOREIGN KEY ("organizationId", "memberId") REFERENCES "member"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionGroupGrant" ADD CONSTRAINT "CollectionGroupGrant_organizationId_collectionId_fkey" FOREIGN KEY ("organizationId", "collectionId") REFERENCES "Collection"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionGroupGrant" ADD CONSTRAINT "CollectionGroupGrant_organizationId_groupId_fkey" FOREIGN KEY ("organizationId", "groupId") REFERENCES "OrganizationGroup"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyPrincipal" ADD CONSTRAINT "ApiKeyPrincipal_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "apikey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyPrincipal" ADD CONSTRAINT "ApiKeyPrincipal_organizationId_memberId_fkey" FOREIGN KEY ("organizationId", "memberId") REFERENCES "member"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyCollectionScope" ADD CONSTRAINT "ApiKeyCollectionScope_organizationId_keyId_fkey" FOREIGN KEY ("organizationId", "keyId") REFERENCES "ApiKeyPrincipal"("organizationId", "keyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKeyCollectionScope" ADD CONSTRAINT "ApiKeyCollectionScope_organizationId_collectionId_fkey" FOREIGN KEY ("organizationId", "collectionId") REFERENCES "Collection"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationQuota" ADD CONSTRAINT "OrganizationQuota_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RagAuditLog" ADD CONSTRAINT "RagAuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_organizationId_documentId_fkey" FOREIGN KEY ("organizationId", "documentId") REFERENCES "Document"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_organizationId_storageLocationId_fkey" FOREIGN KEY ("organizationId", "storageLocationId") REFERENCES "StorageLocation"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentExtraction" ADD CONSTRAINT "DocumentExtraction_organizationId_versionId_fkey" FOREIGN KEY ("organizationId", "versionId") REFERENCES "DocumentVersion"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentExtraction" ADD CONSTRAINT "DocumentExtraction_organizationId_storageLocationId_fkey" FOREIGN KEY ("organizationId", "storageLocationId") REFERENCES "StorageLocation"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionDocument" ADD CONSTRAINT "CollectionDocument_organizationId_collectionId_fkey" FOREIGN KEY ("organizationId", "collectionId") REFERENCES "Collection"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionDocument" ADD CONSTRAINT "CollectionDocument_organizationId_documentId_fkey" FOREIGN KEY ("organizationId", "documentId") REFERENCES "Document"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express deferrable foreign keys. Retention references reject a
-- standalone destination deletion, but a whole-organization cascade must finish
-- removing the referencing rows before these constraints are checked at commit.
ALTER TABLE "StorageLocation" ALTER CONSTRAINT "StorageLocation_organizationId_credentialId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "CollectionConfigRevision" ALTER CONSTRAINT "CollectionConfigRevision_organizationId_vectorConnectionId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "CollectionConfigRevision" ALTER CONSTRAINT "CollectionConfigRevision_organizationId_credentialId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "DocumentVersion" ALTER CONSTRAINT "DocumentVersion_organizationId_storageLocationId_fkey" DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "DocumentExtraction" ALTER CONSTRAINT "DocumentExtraction_organizationId_storageLocationId_fkey" DEFERRABLE INITIALLY DEFERRED;
