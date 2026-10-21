-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CredentialProvider" ADD VALUE 'OPENAI';
ALTER TYPE "CredentialProvider" ADD VALUE 'MISTRAL';

-- CreateTable
CREATE TABLE "OpenAICredentials" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,

    CONSTRAINT "OpenAICredentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MistralCredentials" (
    "id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,

    CONSTRAINT "MistralCredentials_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "OpenAICredentials" ADD CONSTRAINT "OpenAICredentials_id_fkey" FOREIGN KEY ("id") REFERENCES "Credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MistralCredentials" ADD CONSTRAINT "MistralCredentials_id_fkey" FOREIGN KEY ("id") REFERENCES "Credentials"("id") ON DELETE CASCADE ON UPDATE CASCADE;
