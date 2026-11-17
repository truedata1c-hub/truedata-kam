import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

// date приходит из PostgreSQL строкой YYYY-MM-DD: без преобразования в Date и сдвига часового пояса.
pg.types.setTypeParser(1082, (v) => v);

export function createPool(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // Простаивающее соединение может оборваться (перезапуск PostgreSQL, сеть). Без обработчика это роняет процесс;
  // пул сам заменит соединение, а запросы получат ошибку и повторятся по своим правилам.
  pool.on('error', (e) => { console.error('postgres: соединение пула оборвалось:', e.message); });
  return pool;
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('begin');
    const result = await fn(tx);
    await tx.query('commit');
    return result;
  } catch (e) {
    await tx.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    tx.release();
  }
}

/** Транзакция только для чтения и проверок: всегда откатывается (предпросмотр команд). */
export async function withRollback<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('begin');
    return await fn(tx);
  } finally {
    await tx.query('rollback').catch(() => undefined);
    tx.release();
  }
}

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

async function findMigrationsDir(): Promise<string> {
  // Из src/ (tsx) каталог на уровень выше, из dist/src/ — на два.
  for (const dir of [migrationsDir, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')]) {
    try { await readdir(dir); return dir; } catch { /* следующий вариант */ }
  }
  throw new Error('migrations directory not found');
}

/** Применяет SQL-миграции по порядку имён; каждая — в своей транзакции под общей рекомендательной блокировкой. */
export async function migrate(db: Db): Promise<string[]> {
  const dir = await findMigrationsDir();
  const files = (await readdir(dir)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  const conn = await db.connect();
  try {
    await conn.query('select pg_advisory_lock(7240021)');
    await conn.query('create table if not exists public.schema_migration (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await conn.query<{ name: string }>('select name from public.schema_migration')).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await conn.query('begin');
      try {
        await conn.query(sql);
        await conn.query('insert into public.schema_migration(name) values ($1)', [file]);
        await conn.query('commit');
        applied.push(file);
      } catch (e) {
        await conn.query('rollback');
        throw new Error(`migration ${file} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await conn.query('select pg_advisory_unlock(7240021)').catch(() => undefined);
    conn.release();
  }
  return applied;
}
