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

const upsert = db.prepare(`
  INSERT INTO batches (txid, network, started_at, ended_at, total_input_amount, total_input_vtxos,
    total_output_amount, total_output_vtxos, num_batches, commitment_json, tree_json, leaves_json, first_seen)
  VALUES ($txid, $network, $started_at, $ended_at, $total_input_amount, $total_input_vtxos,
    $total_output_amount, $total_output_vtxos, $num_batches, $commitment_json, $tree_json, $leaves_json, $first_seen)
  ON CONFLICT(txid) DO UPDATE SET
    commitment_json=$commitment_json, tree_json=$tree_json, leaves_json=$leaves_json,
    total_output_amount=$total_output_amount, total_output_vtxos=$total_output_vtxos;
`);

export function saveBatch(row) {
  upsert.run(row);
}

export function listBatches(limit = 100) {
  return db
    .prepare(
      `SELECT txid, network, started_at, ended_at, total_output_amount, total_output_vtxos, num_batches
       FROM batches ORDER BY COALESCE(started_at, first_seen) DESC LIMIT ?`,
    )
    .all(limit);
}

export function getBatch(txid) {
  return db.prepare(`SELECT * FROM batches WHERE txid = ?`).get(txid);
}

export function stats() {
  return db
    .prepare(
      `SELECT COUNT(*) AS batches, COALESCE(SUM(total_output_vtxos),0) AS vtxos,
              COALESCE(SUM(total_output_amount),0) AS sats FROM batches`,
    )
    .get();
}
