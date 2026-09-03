// Thin esplora (mempool.space-compatible) client for on-chain fee data.
// Arkade commitment transactions are real settled Bitcoin transactions, so their miner
// fee comes from a block explorer — the Arkade indexer does not expose it.

const DEFAULTS = {
  bitcoin: "https://mempool.space/api",
  mainnet: "https://mempool.space/api",
  mutinynet: "https://mutinynet.com/api",
};

// Pick the esplora base URL for a network. Override with ESPLORA_URL.
export function esploraBase(network) {
  return (process.env.ESPLORA_URL || DEFAULTS[network] || DEFAULTS.bitcoin).replace(/\/$/, "");
}

// GET /tx/{txid} -> { fee, weight, status: { confirmed, block_height, block_time } }
// Returns normalized fee info, or null if the tx isn't visible on-chain yet.
export async function getTxFee(base, txid) {
  const res = await fetch(`${base}/tx/${txid}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`esplora /tx/${txid} -> ${res.status}`);
  const t = await res.json();
  if (t.fee == null || t.weight == null) return null;
  const vsize = Math.ceil(t.weight / 4); // esplora returns weight; vsize = weight / 4
  return {
    fee: t.fee,
    vsize,
    feerate: vsize ? t.fee / vsize : null,
    block_height: t.status?.block_height ?? null,
    block_time: t.status?.block_time ?? null,
    confirmed: !!t.status?.confirmed,
    outputs: (t.vout || []).map((o) => o.value), // on-chain output values (for offboard-fee matching)
  };
}
