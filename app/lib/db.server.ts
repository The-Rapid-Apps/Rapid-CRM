import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../../generated/prisma/client";
import { env } from "./env.server";

/**
 * Prisma 7 uses a WASM query compiler and a driver adapter (no bundled engine),
 * so we connect through the MariaDB driver adapter, which supports both MySQL
 * and MariaDB.
 *
 * Cached on `globalThis` so Vite HMR in dev doesn't open a new pool on every
 * reload.
 */
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function createClient(): PrismaClient {
  const adapter = new PrismaMariaDb(env.DATABASE_URL);
  return new PrismaClient({ adapter });
}

/**
 * Prisma Client is generated code, but the dev server keeps this connection
 * on globalThis across Vite hot reloads. If a model is added while `npm run
 * dev` is running, the cached client can therefore be older than the newly
 * generated client even though TypeScript sees the new delegate.
 */
function supportsCurrentSchema(client: PrismaClient) {
  return (
    typeof (
      client as PrismaClient & {
        apiRequestLog?: { count?: unknown };
      }
    ).apiRequestLog?.count === "function"
  );
}

const cachedPrisma = globalForPrisma.prisma;

export const prisma: PrismaClient =
  cachedPrisma && supportsCurrentSchema(cachedPrisma)
    ? cachedPrisma
    : createClient();

if (cachedPrisma && cachedPrisma !== prisma) {
  void cachedPrisma.$disconnect().catch(() => {
    // The replacement client is already active. A stale connection failing to
    // close must not prevent the server from recovering during development.
  });
}

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// Re-export the Prisma namespace (Decimal, input types, enums) so callers get
// them from one place.
export { Prisma } from "../../generated/prisma/client";
export type { PrismaClient } from "../../generated/prisma/client";
