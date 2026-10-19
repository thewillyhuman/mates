import pg from 'pg';

/**
 * Connection pool factory. One pool per process; everything that touches
 * Postgres receives a `Queryable` so repositories work inside transactions
 * and in tests alike.
 */
export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export type Pool = pg.Pool;

export function createPool(databaseUrl: string, onError?: (err: Error) => void): Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
  });
  // An idle client can be disconnected by the server (restart, failover).
  // Without a listener that is an uncaught exception; with one, the pool
  // simply drops the client and opens a new one on the next query.
  pool.on('error', onError ?? (() => undefined));
  return pool;
}

/** Runs `fn` inside a transaction; rolls back on any throw. */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
