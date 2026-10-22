import { afterAll, beforeEach } from "vitest";
import { TEST_DATABASE_URL } from "./global-setup";

process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.LOG_LEVEL ??= "silent";
process.env.AUTH_SECRET ??= "integration-test-secret-0123456789";

const { db } = await import("@/server/db");

beforeEach(async () => {
  const tables = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) {
    await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
  }
});

afterAll(async () => {
  await db.$disconnect();
});
