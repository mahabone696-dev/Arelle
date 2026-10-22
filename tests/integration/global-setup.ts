import { execSync } from "node:child_process";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://geo:geo@localhost:5432/geo_test";

export default function setup() {
  execSync("pnpm prisma migrate deploy", { stdio: "inherit", env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL } });
}
