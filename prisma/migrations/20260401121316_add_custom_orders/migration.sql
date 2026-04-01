-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomOrder" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "country" TEXT,
    "instagram" TEXT,
    "comments" TEXT,
    "fileUrl" TEXT,
    "sourcePage" TEXT,
    "sourceUrl" TEXT,
    "pendantType" TEXT,
    "pendantSize" TEXT,
    "pendantColor" TEXT,
    "chainLinkType" TEXT,
    "chainThickness" TEXT,
    "chainLength" TEXT,
    "chainColor" TEXT,
    "grillzTeeth" TEXT,
    "grillzColor" TEXT,
    "ringSize" TEXT,
    "ringColor" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomOrder_email_idx" ON "CustomOrder"("email");

-- CreateIndex
CREATE INDEX "CustomOrder_type_idx" ON "CustomOrder"("type");

-- CreateIndex
CREATE INDEX "CustomOrder_createdAt_idx" ON "CustomOrder"("createdAt");
