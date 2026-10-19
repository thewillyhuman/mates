import type { Queryable } from '../db/pool.js';

/** Large artefacts referenced by id from events (decision 0009). */
export const BLOB_KINDS = ['tests_log', 'diff', 'transcript'] as const;
export type BlobKind = (typeof BLOB_KINDS)[number];
export const MAX_BLOB_BYTES = 32 * 1024 * 1024;

export interface Blob {
  id: string;
  runId: string;
  invocationId: string | null;
  kind: BlobKind;
  contentType: string;
  sizeBytes: number;
  data: Buffer;
  createdAt: Date;
}

export async function storeBlob(
  db: Queryable,
  input: {
    runId: string;
    invocationId: string | null;
    kind: BlobKind;
    contentType: string;
    data: Buffer;
  },
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO blobs (run_id, invocation_id, kind, content_type, size_bytes, data)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.runId, input.invocationId, input.kind, input.contentType, input.data.length, input.data],
  );
  return r.rows[0]!.id;
}

export async function getBlob(db: Queryable, id: string): Promise<Blob | undefined> {
  const r = await db.query<{
    id: string;
    run_id: string;
    invocation_id: string | null;
    kind: BlobKind;
    content_type: string;
    size_bytes: number;
    data: Buffer;
    created_at: Date;
  }>(
    'SELECT id, run_id, invocation_id, kind, content_type, size_bytes, data, created_at FROM blobs WHERE id = $1',
    [id],
  );
  const row = r.rows[0];
  if (!row) return undefined;
  return {
    id: row.id,
    runId: row.run_id,
    invocationId: row.invocation_id,
    kind: row.kind,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    data: row.data,
    createdAt: row.created_at,
  };
}

/** Latest blob of a kind for an invocation (the reviewer's diff and test log come from here). */
export async function latestBlob(
  db: Queryable,
  invocationId: string,
  kind: BlobKind,
): Promise<Blob | undefined> {
  const r = await db.query<{ id: string }>(
    'SELECT id FROM blobs WHERE invocation_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 1',
    [invocationId, kind],
  );
  return r.rows[0] ? getBlob(db, r.rows[0].id) : undefined;
}

export async function deleteBlobsOlderThan(
  db: Queryable,
  kind: BlobKind,
  days: number,
): Promise<number> {
  const r = await db.query(
    `DELETE FROM blobs WHERE kind = $1 AND created_at < now() - ($2 || ' days')::interval`,
    [kind, String(days)],
  );
  return r.rowCount ?? 0;
}
