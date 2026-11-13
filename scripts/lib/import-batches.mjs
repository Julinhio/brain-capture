// Shared by restore.mjs and check-restore.mjs: sends a backup to /api/import in batches, so a
// restore never depends on the server's per-request body limit. Each batch is a valid export
// file on its own (same format, version and exportedAt), and the import is idempotent, so a
// batch that fails can simply be retried by running the restore again.
const DEFAULT_BATCH_SIZE = 500;

export function batchSize() {
  const n = Number(process.env.IMPORT_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  if (!Number.isInteger(n) || n < 1) throw new Error('IMPORT_BATCH_SIZE must be a positive integer');
  return n;
}

export async function importInBatches(base, cookie, backup, size = batchSize()) {
  const slices = [];
  for (let i = 0; i < backup.captures.length; i += size) slices.push(backup.captures.slice(i, i + size));
  if (slices.length === 0) slices.push([]); // An empty backup is still validated by the server.

  const totals = { inserted: 0, skipped: 0, deleted: 0, total: 0, batches: 0 };
  for (const captures of slices) {
    const res = await fetch(`${base}/api/import`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...backup, captures }),
    });
    if (!res.ok) throw new Error(`Import failed on batch ${totals.batches + 1} of ${slices.length} (${res.status}): ${await res.text()}`);
    const r = await res.json();
    totals.inserted += r.inserted;
    totals.skipped += r.skipped;
    // Captures deleted for good since the backup: they stay deleted (older servers omit it).
    totals.deleted += r.deleted ?? 0;
    totals.total += r.total;
    totals.batches += 1;
  }
  return totals;
}
