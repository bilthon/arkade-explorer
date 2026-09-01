// Ingest worker: tail the operator's /v1/txs SSE firehose, and for every commitment
// transaction, enrich it via the indexer (commitment summary + VTXO tree + leaf amounts)
// and persist it. Run with `--seed <txid> [txid...]` to backfill known commitments.

import {
  ARK_URL,
  getCommitmentTx,
  getVtxoTree,
  getVtxoTreeLeaves,
  getVtxosByOutpoints,
  parseBatchKey,
  txStream,
} from "./arkade.js";
import { saveBatch, saveFee, listUnpricedBatches } from "./db.js";
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
} else {
  await runWorker();
}
