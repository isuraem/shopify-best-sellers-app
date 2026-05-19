-- CreateTable
CREATE TABLE "VariantAutoSetup" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "sku" TEXT,
    "stockAdded" BOOLEAN NOT NULL DEFAULT false,
    "trigger" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VariantAutoSetup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VariantAutoSetup_shop_idx" ON "VariantAutoSetup"("shop");

-- CreateIndex
CREATE INDEX "VariantAutoSetup_variantId_idx" ON "VariantAutoSetup"("variantId");

-- CreateIndex
CREATE INDEX "VariantAutoSetup_createdAt_idx" ON "VariantAutoSetup"("createdAt");
