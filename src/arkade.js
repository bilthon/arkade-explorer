// Thin client over the public Arkade operator + indexer REST API.
// Endpoints verified live against mutinynet.arkade.sh and arkade.computer.

export const ARK_URL = (process.env.ARK_URL || "https://mutinynet.arkade.sh").replace(/\/$/, "");

async function getJSON(path) {
  const res = await fetch(`${ARK_URL}${path}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.code) {
    throw new Error(`${path} -> ${res.status} ${data?.message || res.statusText}`);
  }
  return data;
}

// GET /v1/indexer/commitmentTx/{txid}
// -> { startedAt, endedAt, batches: { [key]: { totalOutputAmount, totalOutputVtxos, expiresAt, swept } },
//      totalInputAmount, totalInputVtxos, totalOutputAmount, totalOutputVtxos }
export const getCommitmentTx = (txid) => getJSON(`/v1/indexer/commitmentTx/${txid}`);

// GET /v1/indexer/batch/{txid}/{vout}/tree -> { vtxoTree: [{ txid, children: {outIdx: txid} }] }
export const getVtxoTree = (txid, vout) => getJSON(`/v1/indexer/batch/${txid}/${vout}/tree`);

// GET /v1/indexer/batch/{txid}/{vout}/tree/leaves -> { leaves: [{ txid, vout }] }
export const getVtxoTreeLeaves = (txid, vout) =>
  getJSON(`/v1/indexer/batch/${txid}/${vout}/tree/leaves`);

// GET /v1/indexer/vtxos?outpoints=txid:vout&... -> { vtxos: [{ outpoint, amount, script, ... }] }
export async function getVtxosByOutpoints(outpoints) {
  if (!outpoints.length) return [];
  const out = [];
  // chunk to keep the URL sane on wide trees
  for (let i = 0; i < outpoints.length; i += 100) {
    const chunk = outpoints.slice(i, i + 100);
    const qs = chunk.map((o) => `outpoints=${o.txid}:${o.vout}`).join("&");
    const data = await getJSON(`/v1/indexer/vtxos?${qs}`);
    out.push(...(data.vtxos || []));
  }
  return out;
}

// The batches map key encodes the batch output. Seen as "txid:vout"; tolerate a bare vout too.
export function parseBatchKey(key, commitmentTxid) {
  if (key.includes(":")) {
    const [txid, vout] = key.split(":");
    return { txid, vout: Number(vout) };
  }
  if (/^\d+$/.test(key)) return { txid: commitmentTxid, vout: Number(key) };
  return { txid: commitmentTxid, vout: 0 };
}

// SSE consumer for GET /v1/txs. Yields parsed `data:` JSON objects:
//   { streamStarted } | { heartbeat } | { commitmentTx: { txid, tx } } | { arkTx: { txid, tx } }
export async function* txStream(signal) {
  const res = await fetch(`${ARK_URL}/v1/txs`, {
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`/v1/txs -> ${res.status}`);
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) {
        try {
          yield JSON.parse(line.slice(5).trim());
        } catch {
          /* ignore malformed frames */
        }
      }
    }
  }
}
