-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "VectorixMemberAvatarColor" AS ENUM ('BLUE', 'EMERALD', 'AMBER', 'VIOLET', 'ROSE', 'CYAN');

-- CreateEnum
CREATE TYPE "VectorixNotificationRecipientKind" AS ENUM ('MEMBER');

-- CreateEnum
CREATE TYPE "VectorixNotificationChannel" AS ENUM ('IN_APP', 'PUSH', 'EMAIL');

-- CreateEnum
CREATE TYPE "VectorixNotificationDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "SuperAdminAuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "details" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuperAdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT DEFAULT 'fr',
    "hiddenMenuKeys" JSONB NOT NULL DEFAULT '[]',
    "hiddenMenuVersion" INTEGER NOT NULL DEFAULT 0,
    "menuSectionOrder" JSONB NOT NULL DEFAULT '{}',
    "twoFactorEnabled" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "activeOrganizationId" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "twoFactor" (
    "id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "backupCodes" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verified" BOOLEAN DEFAULT true,
    "failedVerificationCount" INTEGER DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "twoFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "passkey" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "publicKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialID" TEXT NOT NULL,
    "counter" INTEGER NOT NULL,
    "deviceType" TEXT NOT NULL,
    "backedUp" BOOLEAN NOT NULL,
    "transports" TEXT,
    "createdAt" TIMESTAMP(3),
    "aaguid" TEXT,

    CONSTRAINT "passkey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "apikey" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT,
    "start" TEXT,
    "referenceId" TEXT NOT NULL,
    "prefix" TEXT,
    "key" TEXT NOT NULL,
    "refillInterval" INTEGER,
    "refillAmount" INTEGER,
    "lastRefillAt" TIMESTAMP(3),
    "enabled" BOOLEAN DEFAULT true,
    "rateLimitEnabled" BOOLEAN DEFAULT true,
    "rateLimitTimeWindow" INTEGER DEFAULT 86400000,
    "rateLimitMax" INTEGER DEFAULT 10,
    "requestCount" INTEGER DEFAULT 0,
    "remaining" INTEGER,
    "lastRequest" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "permissions" TEXT,
    "metadata" TEXT,
    "vectorixLegacyFullAccess" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "apikey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VectorixAccessControlState" (
    "id" TEXT NOT NULL,
    "initializedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VectorixAccessControlState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizationRole" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "organizationRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "vectorixLegacyAccess" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "metadata" TEXT,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationSetting" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "group" TEXT NOT NULL DEFAULT 'general',

    CONSTRAINT "OrganizationSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "avatarColor" "VectorixMemberAvatarColor",
    "menuPins" JSONB NOT NULL DEFAULT '[]',
    "menuPinsVersion" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inviterId" TEXT NOT NULL,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VectorixFeatureDefinition" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'general',
    "defaultEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isPaywalled" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "externalKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VectorixFeatureDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VectorixOrganizationFeatureOverride" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "featureId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VectorixOrganizationFeatureOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VectorixNotificationRecipient" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "VectorixNotificationRecipientKind" NOT NULL,
    "memberOrganizationId" TEXT,
    "memberId" TEXT,
    "lastSequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VectorixNotificationRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VectorixNotification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventKey" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "actorMemberOrganizationId" TEXT,
    "actorMemberId" TEXT,
    "sourceKind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "actionKind" TEXT NOT NULL,
    "actionVersion" INTEGER NOT NULL DEFAULT 1,
    "actionData" JSONB NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VectorixNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VectorixNotificationPreference" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "channel" "VectorixNotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VectorixNotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VectorixNotificationDelivery" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "channel" "VectorixNotificationChannel" NOT NULL,
    "status" "VectorixNotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" TEXT,
    "leasedUntil" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "skippedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VectorixNotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VectorixPushSubscription" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "application" TEXT NOT NULL,
    "deviceKey" TEXT NOT NULL,
    "endpointHash" TEXT NOT NULL,
    "subscriptionEncrypted" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "expirationTime" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VectorixPushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SuperAdminAuditLog_userId_createdAt_idx" ON "SuperAdminAuditLog"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SuperAdminAuditLog_targetId_idx" ON "SuperAdminAuditLog"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "twoFactor_secret_idx" ON "twoFactor"("secret");

-- CreateIndex
CREATE INDEX "twoFactor_userId_idx" ON "twoFactor"("userId");

-- CreateIndex
CREATE INDEX "apikey_configId_idx" ON "apikey"("configId");

-- CreateIndex
CREATE INDEX "apikey_referenceId_idx" ON "apikey"("referenceId");

-- CreateIndex
CREATE INDEX "apikey_key_idx" ON "apikey"("key");

-- CreateIndex
CREATE UNIQUE INDEX "organizationRole_organizationId_role_key" ON "organizationRole"("organizationId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationSetting_organizationId_key_key" ON "OrganizationSetting"("organizationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "member_organizationId_id_key" ON "member"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "VectorixFeatureDefinition_key_key" ON "VectorixFeatureDefinition"("key");

-- CreateIndex
CREATE INDEX "VectorixFeatureDefinition_category_isActive_idx" ON "VectorixFeatureDefinition"("category", "isActive");

-- CreateIndex
CREATE INDEX "VectorixOrganizationFeatureOverride_featureId_idx" ON "VectorixOrganizationFeatureOverride"("featureId");

-- CreateIndex
CREATE INDEX "VectorixOrganizationFeatureOverride_organizationId_expiresA_idx" ON "VectorixOrganizationFeatureOverride"("organizationId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "VectorixOrganizationFeatureOverride_organizationId_featureI_key" ON "VectorixOrganizationFeatureOverride"("organizationId", "featureId");

-- CreateIndex
CREATE INDEX "VectorixNotificationRecipient_memberOrganizationId_memberId_idx" ON "VectorixNotificationRecipient"("memberOrganizationId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "VectorixNotificationRecipient_organizationId_id_key" ON "VectorixNotificationRecipient"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "VectorixNotificationRecipient_organizationId_memberId_key" ON "VectorixNotificationRecipient"("organizationId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "VectorixNotificationRecipient_memberOrganizationId_memberId_key" ON "VectorixNotificationRecipient"("memberOrganizationId", "memberId");

-- CreateIndex
CREATE INDEX "VectorixNotification_organizationId_recipientId_readAt_sequ_idx" ON "VectorixNotification"("organizationId", "recipientId", "readAt", "sequence" DESC);

-- CreateIndex
CREATE INDEX "VectorixNotification_organizationId_sourceKind_sourceId_idx" ON "VectorixNotification"("organizationId", "sourceKind", "sourceId");

-- CreateIndex
CREATE INDEX "VectorixNotification_actorMemberOrganizationId_actorMemberI_idx" ON "VectorixNotification"("actorMemberOrganizationId", "actorMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "VectorixNotification_organizationId_eventKey_recipientId_key" ON "VectorixNotification"("organizationId", "eventKey", "recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "VectorixNotification_organizationId_recipientId_sequence_key" ON "VectorixNotification"("organizationId", "recipientId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "VectorixNotification_organizationId_id_key" ON "VectorixNotification"("organizationId", "id");

-- CreateIndex
CREATE INDEX "VectorixNotificationPreference_organizationId_recipientId_idx" ON "VectorixNotificationPreference"("organizationId", "recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "VectorixNotificationPreference_organizationId_recipientId_e_key" ON "VectorixNotificationPreference"("organizationId", "recipientId", "eventType", "channel");

-- CreateIndex
CREATE INDEX "VectorixNotificationDelivery_status_availableAt_leasedUntil_idx" ON "VectorixNotificationDelivery"("status", "availableAt", "leasedUntil");

-- CreateIndex
CREATE INDEX "VectorixNotificationDelivery_organizationId_channel_status_idx" ON "VectorixNotificationDelivery"("organizationId", "channel", "status");

-- CreateIndex
CREATE UNIQUE INDEX "VectorixNotificationDelivery_organizationId_notificationId__key" ON "VectorixNotificationDelivery"("organizationId", "notificationId", "channel");

-- CreateIndex
CREATE INDEX "VectorixPushSubscription_organizationId_recipientId_applica_idx" ON "VectorixPushSubscription"("organizationId", "recipientId", "application", "revokedAt");

-- CreateIndex
CREATE INDEX "VectorixPushSubscription_endpointHash_idx" ON "VectorixPushSubscription"("endpointHash");

-- CreateIndex
CREATE UNIQUE INDEX "VectorixPushSubscription_recipient_application_endpoint_key" ON "VectorixPushSubscription"("organizationId", "recipientId", "application", "endpointHash");

-- CreateIndex
CREATE UNIQUE INDEX "VectorixPushSubscription_recipient_application_device_key" ON "VectorixPushSubscription"("organizationId", "recipientId", "application", "deviceKey");

-- AddForeignKey
ALTER TABLE "SuperAdminAuditLog" ADD CONSTRAINT "SuperAdminAuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "twoFactor" ADD CONSTRAINT "twoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizationRole" ADD CONSTRAINT "organizationRole_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationSetting" ADD CONSTRAINT "OrganizationSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VectorixOrganizationFeatureOverride" ADD CONSTRAINT "VectorixOrganizationFeatureOverride_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VectorixOrganizationFeatureOverride" ADD CONSTRAINT "VectorixOrganizationFeatureOverride_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "VectorixFeatureDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VectorixNotificationRecipient" ADD CONSTRAINT "VectorixNotificationRecipient_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VectorixNotificationRecipient" ADD CONSTRAINT "VectorixNotificationRecipient_memberOrganizationId_memberI_fkey" FOREIGN KEY ("memberOrganizationId", "memberId") REFERENCES "member"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VectorixNotification" ADD CONSTRAINT "VectorixNotification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VectorixNotification" ADD CONSTRAINT "VectorixNotification_organizationId_recipientId_fkey" FOREIGN KEY ("organizationId", "recipientId") REFERENCES "VectorixNotificationRecipient"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VectorixNotification" ADD CONSTRAINT "VectorixNotification_actorMemberOrganizationId_actorMember_fkey" FOREIGN KEY ("actorMemberOrganizationId", "actorMemberId") REFERENCES "member"("organizationId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VectorixNotificationPreference" ADD CONSTRAINT "VectorixNotificationPreference_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VectorixNotificationPreference" ADD CONSTRAINT "VectorixNotificationPreference_organizationId_recipientId_fkey" FOREIGN KEY ("organizationId", "recipientId") REFERENCES "VectorixNotificationRecipient"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VectorixNotificationDelivery" ADD CONSTRAINT "VectorixNotificationDelivery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VectorixNotificationDelivery" ADD CONSTRAINT "VectorixNotificationDelivery_organizationId_notificationId_fkey" FOREIGN KEY ("organizationId", "notificationId") REFERENCES "VectorixNotification"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VectorixPushSubscription" ADD CONSTRAINT "VectorixPushSubscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VectorixPushSubscription" ADD CONSTRAINT "VectorixPushSubscription_organizationId_recipientId_fkey" FOREIGN KEY ("organizationId", "recipientId") REFERENCES "VectorixNotificationRecipient"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
