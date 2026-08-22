import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('juice-central-migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = new Set(
      (await client.query<{ filename: string }>("SELECT filename FROM schema_migrations")).rows.map(
        ({ filename }) => filename,
      ),
    );
    for (const filename of (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      if (applied.has(filename)) continue;
      await client.query("BEGIN");
      try {
        await client.query(await readFile(join(migrationsDirectory, filename), "utf8"));
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext('juice-central-migrations'))");
    } finally {
      client.release();
    }
  }
}
