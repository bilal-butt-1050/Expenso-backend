import { execSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { prisma } from "../../src/lib/prisma";

/**
 * A throwaway database brought to any point in the migration history (T4.6), so migration tests
 * run the real SQL against data in the shape it had before.
 *
 * Migrations are applied with `prisma migrate deploy` from a temporary copy of the migrations
 * folder holding only the ones wanted so far. Applying the rest later is exactly what production
 * went through.
 */

const MIGRATIONS = join(__dirname, "../../prisma/migrations");
const SCHEMA = join(__dirname, "../../prisma/schema.prisma");

export const ALL_MIGRATIONS = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

export function migrationSql(name: string): string {
  return join(MIGRATIONS, name, "migration.sql");
}

export async function scratchDatabase(name: string) {
  if (!name.startsWith("expenso_test_")) throw new Error("scratch databases must be named expenso_test_*");
  const base = new URL(process.env.DATABASE_URL!);
  const url = new URL(base.toString());
  url.pathname = `/${name}`;

  await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await prisma.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  // Production's Postgres (the Docker image) runs in UTC. A local Windows install may not, and
  // time zone arithmetic in a migration can depend on the session's zone.
  await prisma.$executeRawUnsafe(`ALTER DATABASE "${name}" SET timezone TO 'UTC'`);

  const dir = mkdtempSync(join(tmpdir(), "expenso-mig-"));
  copyFileSync(SCHEMA, join(dir, "schema.prisma"));
  mkdirSync(join(dir, "migrations"));
  copyFileSync(join(MIGRATIONS, "migration_lock.toml"), join(dir, "migrations", "migration_lock.toml"));

  const env = { ...process.env, DATABASE_URL: url.toString(), DIRECT_URL: url.toString() };
  const client = new PrismaClient({ datasourceUrl: url.toString() });

  return {
    client,
    /** Applies every migration up to and including `last` (or all of them) that isn't applied yet. */
    deployThrough(last?: string) {
      for (const m of ALL_MIGRATIONS) {
        if (last && m > last) break;
        cpSync(join(MIGRATIONS, m), join(dir, "migrations", m), { recursive: true });
      }
      execSync(`npx prisma migrate deploy --schema "${join(dir, "schema.prisma")}"`, { stdio: "pipe", env });
    },
    /** Runs a SQL file as one script, the way a migration runs. Throws with Postgres's error. */
    runSqlFile(file: string) {
      try {
        execSync(`npx prisma db execute --file "${file}" --url "${url.toString()}"`, { stdio: "pipe", env });
      } catch (error) {
        throw new Error(String((error as { stderr?: Buffer }).stderr ?? error));
      }
    },
    async drop() {
      await client.$disconnect();
      rmSync(dir, { recursive: true, force: true });
      await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    },
  };
}
