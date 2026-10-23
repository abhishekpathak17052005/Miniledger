CREATE TABLE IF NOT EXISTS "Friend" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "normalizedName" VARCHAR(80) NOT NULL,
    "phone" VARCHAR(15),
    "normalizedPhone" VARCHAR(15),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Friend_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Loan" ADD COLUMN IF NOT EXISTS "friendId" TEXT;
ALTER TABLE "Repayment" ADD COLUMN IF NOT EXISTS "note" VARCHAR(200);

CREATE INDEX IF NOT EXISTS "Friend_userId_normalizedName_idx" ON "Friend"("userId", "normalizedName");
CREATE INDEX IF NOT EXISTS "Friend_userId_normalizedPhone_idx" ON "Friend"("userId", "normalizedPhone");
CREATE INDEX IF NOT EXISTS "Loan_userId_friendId_idx" ON "Loan"("userId", "friendId");
CREATE INDEX IF NOT EXISTS "Repayment_loanId_idx" ON "Repayment"("loanId");
CREATE INDEX IF NOT EXISTS "Repayment_repaidAt_idx" ON "Repayment"("repaidAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Friend_userId_fkey'
  ) THEN
    ALTER TABLE "Friend" ADD CONSTRAINT "Friend_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Loan_friendId_fkey'
  ) THEN
    ALTER TABLE "Loan" ADD CONSTRAINT "Loan_friendId_fkey"
      FOREIGN KEY ("friendId") REFERENCES "Friend"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill one profile per existing user/name pair without deleting or rewriting loan data.
INSERT INTO "Friend" ("id", "userId", "name", "normalizedName", "createdAt", "updatedAt")
SELECT
  'legacy_' || md5("userId" || ':' || normalized_name),
  "userId",
  MIN("friendName"),
  normalized_name,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM (
  SELECT
    "userId",
    "friendName",
    regexp_replace(lower(trim("friendName")), '\s+', ' ', 'g') AS normalized_name
  FROM "Loan"
  WHERE "friendId" IS NULL
) legacy
WHERE NOT EXISTS (
  SELECT 1 FROM "Friend" f
  WHERE f."userId" = legacy."userId" AND f."normalizedName" = legacy.normalized_name
)
GROUP BY "userId", normalized_name;

UPDATE "Loan" l
SET "friendId" = f."id"
FROM "Friend" f
WHERE l."friendId" IS NULL
  AND f."userId" = l."userId"
  AND f."normalizedName" = regexp_replace(lower(trim(l."friendName")), '\s+', ' ', 'g');
