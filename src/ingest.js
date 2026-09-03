// Ingest worker: tail the operator's /v1/txs SSE firehose, and for every commitment
// transaction, enrich it via the indexer (commitment summary + VTXO tree + leaf amounts)
// and persist it. Run with `--seed <txid> [txid...]` to backfill known commitments.

import {
  ARK_URL,
  getCommitmentTx,
  getVtxoTree,
  getVtxoTreeLeaves,
  getVtxosByOutpoints,
  getForfeitTxs,
  getVirtualTxs,
  parseBatchKey,
  txStream,
} from "./arkade.js";
import {
  saveBatch,
  saveFee,
  listUnpricedBatches,
  saveSweep,
  listSweepCandidates,
  listRowsMissingExpiry,
  saveExpiry,
  saveInputLeaves,
  listRowsMissingInputs,
} from "./db.js";
import { psbtInputs } from "./psbt.js";
import { esploraBase, getTxFee } from "./esplora.js";

let NETWORK = "unknown";
let ESPLORA = esploraBase(NETWORK);

async function loadNetwork() {
  try {
    const info = await fetch(`${ARK_URL}/v1/info`).then((r) => r.json());
    NETWORK = info.network || "unknown";
  } catch {
    /* leave as unknown */
  }
  ESPLORA = esploraBase(NETWORK);
}

const toSat = (s) => (s == null ? 0 : Number(s));
const ts = (s) => (s == null ? null : Number(s));

// Derive sweep status + expiry from a commitment's batch infos. swept: true only once every
// batch has been reclaimed on-chain. expires_at: the latest batch expiry (unix seconds).
function sweepInfo(infos) {
  const swept = infos.length && infos.every((i) => i.swept === true) ? 1 : 0;
  const exps = infos.map((i) => Number(i.expiresAt)).filter((n) => Number.isFinite(n) && n > 0);
  return { swept, expires_at: exps.length ? Math.max(...exps) : null };
}

// Rebuild the batch's input VTXOs (bow-tie left side) from its forfeit txs:
// forfeitTxs → fetch each PSBT → decode inputs → resolve which are VTXOs (connectors drop out).
async function reconstructInputs(txid) {
  const { txids = [] } = await getForfeitTxs(txid).catch(() => ({ txids: [] }));
  if (!txids.length) return [];
  const { txs = [] } = await getVirtualTxs(txids).catch(() => ({ txs: [] }));
  const seen = new Set(), outpoints = [];
  for (const t of txs) {
    let ins = [];
    try { ins = psbtInputs(t); } catch { /* skip unparseable forfeit tx */ }
    for (const o of ins) {
      const k = `${o.txid}:${o.vout}`;
      if (!seen.has(k)) { seen.add(k); outpoints.push(o); }
    }
  }
  const vtxos = await getVtxosByOutpoints(outpoints).catch(() => []);
  return vtxos.map((v) => ({
    txid: v.outpoint?.txid,
    vout: v.outpoint?.vout,
    amount: toSat(v.amount),
    script: v.script,
  }));
}

export async function enrichCommitment(txid) {
  const commitment = await getCommitmentTx(txid);
  const batchEntries = Object.entries(commitment.batches || {});

  const trees = [];
  const leafSets = [];
  for (const [key, info] of batchEntries) {
    const outpoint = parseBatchKey(key, txid);
    const [{ vtxoTree = [] }, { leaves = [] }] = await Promise.all([
      getVtxoTree(outpoint.txid, outpoint.vout).catch(() => ({ vtxoTree: [] })),
      getVtxoTreeLeaves(outpoint.txid, outpoint.vout).catch(() => ({ leaves: [] })),
    ]);
    const vtxos = await getVtxosByOutpoints(leaves).catch(() => []);
    const leafRows = vtxos.map((v) => ({
      txid: v.outpoint?.txid,
      vout: v.outpoint?.vout,
      amount: toSat(v.amount),
      script: v.script,
      isSpent: !!v.isSpent,
    }));
    trees.push({ batchKey: key, outpoint, info, nodes: vtxoTree });
    leafSets.push({ batchKey: key, outpoint, leaves: leafRows });
  }

  // On-chain cost: the commitment is a real Bitcoin tx, so its miner fee comes from esplora.
  const fee = await getTxFee(ESPLORA, txid).catch(() => null);

  // Input VTXOs (bow-tie left side), reconstructed from the batch's forfeit txs.
  const inputLeaves = await reconstructInputs(txid).catch(() => []);

  // Sweep status is time-varying: always live at settlement, swept only once every batch tree
  // has expired and been reclaimed. Captured live here; `--refresh-sweeps` re-checks expired ones.
  const { swept, expires_at } = sweepInfo(batchEntries.map(([, info]) => info || {}));

  saveBatch({
    txid,
    network: NETWORK,
    started_at: ts(commitment.startedAt),
    ended_at: ts(commitment.endedAt),
    total_input_amount: toSat(commitment.totalInputAmount),
    total_input_vtxos: Number(commitment.totalInputVtxos || 0),
    total_output_amount: toSat(commitment.totalOutputAmount),
    total_output_vtxos: Number(commitment.totalOutputVtxos || 0),
    num_batches: batchEntries.length,
    commitment_json: JSON.stringify(commitment),
    tree_json: JSON.stringify(trees),
    leaves_json: JSON.stringify(leafSets),
    first_seen: Math.floor(Date.now() / 1000),
    fee: fee?.fee ?? null,
    vsize: fee?.vsize ?? null,
    feerate: fee?.feerate ?? null,
    block_height: fee?.block_height ?? null,
    block_time: fee?.block_time ?? null,
    swept,
    expires_at,
    input_leaves_json: JSON.stringify(inputLeaves),
  });

  const leafCount = leafSets.reduce((n, s) => n + s.leaves.length, 0);
  console.log(
    `[enriched] ${txid}  batches=${batchEntries.length} vtxos=${commitment.totalOutputVtxos} ` +
      `leaves_resolved=${leafCount} sats=${toSat(commitment.totalOutputAmount)} fee=${fee?.fee ?? "?"}`,
  );
}

async function runWorker() {
  console.log(`[ingest] tailing ${ARK_URL}/v1/txs  (network=${NETWORK})`);
  // Auto-reconnect: SSE drops are expected.
  for (;;) {
    try {
      for await (const msg of txStream()) {
        if (msg.commitmentTx?.txid) {
          console.log(`[seen] commitmentTx ${msg.commitmentTx.txid}`);
          await enrichCommitment(msg.commitmentTx.txid).catch((e) =>
            console.error(`[enrich error] ${e.message}`),
          );
        }
      }
    } catch (e) {
      console.error(`[stream error] ${e.message} — reconnecting in 3s`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// One-shot: price any batches that don't yet have an on-chain fee (e.g. after a bulk
// ingest, or for txs that were unconfirmed when first seen). Gentle on the public API.
async function backfillFees() {
  const rows = listUnpricedBatches();
  console.log(`[backfill-fees] pricing ${rows.length} batches via ${ESPLORA}`);
  let priced = 0;
  for (let i = 0; i < rows.length; i++) {
    const { txid } = rows[i];
    try {
      const f = await getTxFee(ESPLORA, txid);
      if (f) {
        saveFee({ txid, fee: f.fee, vsize: f.vsize, feerate: f.feerate, block_height: f.block_height, block_time: f.block_time });
        priced++;
      }
    } catch (e) {
      console.error(`[backfill error] ${txid}: ${e.message}`);
    }
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${rows.length} (${priced} priced)`);
    await new Promise((r) => setTimeout(r, 120)); // ~8 req/s — polite to the public esplora
  }
  console.log(`[backfill-fees] done: ${priced}/${rows.length} priced`);
}

// One-shot: re-check batches that have passed their expiry and may now be swept. Cheap —
// it only revisits expired, not-yet-swept rows, and updates any the operator has reclaimed.
async function refreshSweeps() {
  // Hydrate expiry + initial swept from stored commitment_json for rows ingested before these
  // columns existed (local only, no network). New rows already have this from ingest time.
  const missing = listRowsMissingExpiry();
  let hydrated = 0;
  for (const { txid, commitment_json } of missing) {
    try {
      const { swept, expires_at } = sweepInfo(Object.values(JSON.parse(commitment_json).batches || {}));
      if (expires_at != null) {
        saveExpiry({ txid, swept, expires_at });
        hydrated++;
      }
    } catch {
      /* skip unparseable commitment_json */
    }
  }
  if (hydrated) console.log(`[refresh-sweeps] hydrated expiry for ${hydrated} pre-existing rows`);

  const now = Math.floor(Date.now() / 1000);
  const rows = listSweepCandidates(now);
  console.log(`[refresh-sweeps] re-checking ${rows.length} expired, not-yet-swept batches via ${ARK_URL}`);
  let swept = 0;
  for (let i = 0; i < rows.length; i++) {
    const { txid } = rows[i];
    try {
      const c = await getCommitmentTx(txid);
      const infos = Object.values(c.batches || {});
      if (infos.length && infos.every((b) => b.swept === true)) {
        saveSweep({ txid, swept: 1 });
        swept++;
      }
    } catch (e) {
      console.error(`[refresh error] ${txid}: ${e.message}`);
    }
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${rows.length} (${swept} newly swept)`);
    await new Promise((r) => setTimeout(r, 80)); // gentle on the indexer
  }
  console.log(`[refresh-sweeps] done: ${swept}/${rows.length} newly swept`);
}

// One-shot: reconstruct input VTXOs for batches that don't have them yet (ingested before
// the bow-tie existed). One forfeitTxs + virtualTx + vtxos round-trip per batch.
async function backfillInputs() {
  const rows = listRowsMissingInputs(NETWORK);
  console.log(`[backfill-inputs] reconstructing inputs for ${rows.length} ${NETWORK} batches via ${ARK_URL}`);
  let done = 0;
  for (let i = 0; i < rows.length; i++) {
    const { txid } = rows[i];
    try {
      const inputLeaves = await reconstructInputs(txid);
      saveInputLeaves({ txid, input_leaves_json: JSON.stringify(inputLeaves) });
      done++;
    } catch (e) {
      console.error(`[backfill-inputs error] ${txid}: ${e.message}`);
    }
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${rows.length}`);
    await new Promise((r) => setTimeout(r, 100)); // gentle on the indexer
  }
  console.log(`[backfill-inputs] done: ${done}/${rows.length}`);
}

const args = process.argv.slice(2);
await loadNetwork();
if (args[0] === "--seed") {
  for (const txid of args.slice(1)) {
    await enrichCommitment(txid).catch((e) => console.error(`[seed error] ${txid}: ${e.message}`));
  }
  process.exit(0);
} else if (args[0] === "--backfill-fees") {
  await backfillFees();
  process.exit(0);
} else if (args[0] === "--refresh-sweeps") {
  await refreshSweeps();
  process.exit(0);
} else if (args[0] === "--backfill-inputs") {
  await backfillInputs();
  process.exit(0);
} else {
  await runWorker();
}
