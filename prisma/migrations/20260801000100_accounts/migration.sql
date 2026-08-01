PRAGMA foreign_keys=OFF;

CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "normalizedUsername" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "emailVerifiedAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active' CHECK ("status" IN ('active', 'disabled')),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "EmailVerificationChallenge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "normalizedEmail" TEXT NOT NULL,
    "purpose" TEXT NOT NULL CHECK ("purpose" IN ('registration', 'password-reset')),
    "codeHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "resendAvailableAt" DATETIME NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0 CHECK ("failedAttempts" >= 0),
    "consumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfSecret" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "lastActivityAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AvatarAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL CHECK ("mimeType" = 'image/webp'),
    "byteSize" INTEGER NOT NULL CHECK ("byteSize" > 0),
    "width" INTEGER NOT NULL CHECK ("width" = 512),
    "height" INTEGER NOT NULL CHECK ("height" = 512),
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AvatarAsset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "User_normalizedEmail_key" ON "User"("normalizedEmail");
CREATE UNIQUE INDEX "User_normalizedUsername_key" ON "User"("normalizedUsername");
CREATE INDEX "EmailVerificationChallenge_normalizedEmail_purpose_createdAt_idx" ON "EmailVerificationChallenge"("normalizedEmail", "purpose", "createdAt");
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
CREATE UNIQUE INDEX "AvatarAsset_userId_key" ON "AvatarAsset"("userId");
CREATE UNIQUE INDEX "AvatarAsset_storageKey_key" ON "AvatarAsset"("storageKey");

PRAGMA foreign_keys=ON;
PRAGMA optimize;
