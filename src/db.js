import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "..", "data.db");

export const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS batches (
    txid                 TEXT PRIMARY KEY,
    network              TEXT,
    started_at           INTEGER,
    ended_at             INTEGER,
    total_input_amount   INTEGER,
    total_input_vtxos    INTEGER,
    total_output_amount  INTEGER,
    total_output_vtxos   INTEGER,
    num_batches          INTEGER,
    commitment_json      TEXT,
    tree_json            TEXT,
    leaves_json          TEXT,
    first_seen           INTEGER
  );
`);

// Additive migration: on-chain cost columns (from esplora). Idempotent — re-adding an
// existing column throws, which we ignore, so this runs safely on old and fresh databases.
for (const [name, type] of [
  ["fee", "INTEGER"],
  ["vsize", "INTEGER"],
  ["feerate", "REAL"],
  ["block_height", "INTEGER"],
  ["block_time", "INTEGER"],
]) {
  try {
    db.exec(`ALTER TABLE batches ADD COLUMN ${name} ${type}`);
  } catch {
    /* column already exists */
  }
}

const upsert = db.prepare(`
  INSERT INTO batches (txid, network, started_at, ended_at, total_input_amount, total_input_vtxos,
    total_output_amount, total_output_vtxos, num_batches, commitment_json, tree_json, leaves_json, first_seen,
    fee, vsize, feerate, block_height, block_time)
  VALUES ($txid, $network, $started_at, $ended_at, $total_input_amount, $total_input_vtxos,
    $total_output_amount, $total_output_vtxos, $num_batches, $commitment_json, $tree_json, $leaves_json, $first_seen,
    $fee, $vsize, $feerate, $block_height, $block_time)
  ON CONFLICT(txid) DO UPDATE SET
    commitment_json=$commitment_json, tree_json=$tree_json, leaves_json=$leaves_json,
    total_output_amount=$total_output_amount, total_output_vtxos=$total_output_vtxos,
    fee=COALESCE($fee, fee), vsize=COALESCE($vsize, vsize), feerate=COALESCE($feerate, feerate),
    block_height=COALESCE($block_height, block_height), block_time=COALESCE($block_time, block_time);
`);

// Targeted fee update — used by the backfill pass and unconfirmed-tx retries.
const feeUpdate = db.prepare(`
  UPDATE batches SET fee=$fee, vsize=$vsize, feerate=$feerate,
    block_height=$block_height, block_time=$block_time WHERE txid=$txid
`);

export function saveFee(row) {
  feeUpdate.run(row);
}

export function listUnpricedBatches() {
  return db
    .prepare(`SELECT txid FROM batches WHERE fee IS NULL ORDER BY COALESCE(started_at, first_seen) DESC`)
    .all();
}

export function saveBatch(row) {
  upsert.run(row);
}

export function listBatches(limit = 100, offset = 0) {
  return db
    .prepare(
      `SELECT txid, network, started_at, ended_at, total_output_amount, total_output_vtxos, num_batches,
              fee, feerate
       FROM batches ORDER BY COALESCE(started_at, first_seen) DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset);
}

export function countBatches() {
  return db.prepare(`SELECT COUNT(*) AS n FROM batches`).get().n;
}

export function getBatch(txid) {
  return db.prepare(`SELECT * FROM batches WHERE txid = ?`).get(txid);
}

export function stats() {
  return db
    .prepare(
      `SELECT COUNT(*) AS batches, COALESCE(SUM(total_output_vtxos),0) AS vtxos,
              COALESCE(SUM(total_output_amount),0) AS sats, COALESCE(SUM(fee),0) AS fees FROM batches`,
    )
    .get();
}
