import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

export class Database {
  readonly pool: pg.Pool;
  constructor(url: string) { this.pool = new Pool({ connectionString: url, max: 10 }); }

  async migrate(): Promise<void> {
    const current = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(current, '../migrations'), join(current, '../../migrations')];
    const directory = candidates.find(existsSync);
    if (!directory) throw new Error('Migration directory was not found');
    await this.pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const file of readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
      const sql = readFileSync(join(directory, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await this.pool.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE version=$1', [file]);
      if (existing.rowCount) {
        if (existing.rows[0]?.checksum !== checksum) throw new Error(`Applied migration ${file} was modified`);
        continue;
      }
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1,$2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    }
  }

  async close(): Promise<void> { await this.pool.end(); }
}

