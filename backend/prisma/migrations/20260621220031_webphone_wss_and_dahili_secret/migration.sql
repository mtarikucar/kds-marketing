-- AlterTable
ALTER TABLE "marketing_users" ADD COLUMN     "dahiliSecret" TEXT;

-- AlterTable
ALTER TABLE "telephony_configs" ADD COLUMN     "sipDomain" TEXT,
ADD COLUMN     "wssUrl" TEXT;
