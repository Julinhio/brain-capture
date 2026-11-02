import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

// Every entry point (dev, tests, `npm start` on Railway) runs from the repository root.
function resolveMigrationsFolder(): string {
  return path.resolve(process.cwd(), 'drizzle');
}

/**
 * Production talks to Railway PostgreSQL through `pg`. Local dev and tests use PGlite,
 * an in-process PostgreSQL build, so the same SQL and constraints are exercised without
 * a database server on the machine. `pglite:memory` gives each test a fresh database.
 */
export async function openDb(url: string): Promise<DbHandle> {
  if (url.startsWith('pglite:')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const target = url.slice('pglite:'.length);
    if (target !== 'memory') mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    const client = target === 'memory' ? new PGlite() : new PGlite(target);
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
    return { db: db as unknown as Db, close: () => client.close() };
  }

  const { Pool } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const pool = new Pool({ connectionString: url, max: 5 });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: resolveMigrationsFolder() });
  return { db: db as unknown as Db, close: () => pool.end() };
}
