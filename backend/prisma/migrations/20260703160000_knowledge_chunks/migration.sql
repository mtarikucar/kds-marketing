-- Faz 1 Brand Brain: retrievable KnowledgeChunk with a plain double-precision
-- embedding array (extension-free; pgvector is the scale-up path).

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "ord" INTEGER NOT NULL DEFAULT 0,
    "content" TEXT NOT NULL,
    "embedding" DOUBLE PRECISION[],
    "tokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "knowledge_chunks_workspaceId_docId_ord_idx" ON "knowledge_chunks"("workspaceId", "docId", "ord");

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_docId_fkey" FOREIGN KEY ("docId") REFERENCES "knowledge_docs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

