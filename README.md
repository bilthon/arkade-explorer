# Arkade Batch Explorer — Proof of Concept

A mempool.space-style explorer for Arkade batch commitments. It tails the operator's
public transaction firehose, enriches each commitment transaction via the indexer
(summary + VTXO tree + per-leaf amounts), and renders it.

**Zero dependencies** — Node 22's built-in `fetch`, `node:sqlite`, and `node:http`.

## What it proves

1. **Discovery** — the `GET /v1/txs` SSE stream emits `{commitmentTx}` / `{arkTx}` frames live,
   solving the "there is no list-all-batches endpoint" gap.
2. **Enrichment** — for each commitment: `GET /v1/indexer/commitmentTx/{txid}` →
   `…/batch/{txid}/{vout}/tree` + `…/tree/leaves` → `…/vtxos?outpoints=…` for amounts.
   All endpoints are public and unauthenticated.
3. **Rendering** — a list of recent batches and a detail view with the VTXO tree
   (SVG fan-out) and a leaf table showing individual amounts + P2TR scripts.

Verified end-to-end against a **real mainnet commitment**
(`e1d4a38e…4283edf2`, 1 vtxo, 2,408 sats).

## Run

```bash
# Point at an operator (mainnet shown; default is mutinynet)
export ARK_URL=https://arkade.computer

# 1. Backfill a known commitment (or any txids you have)
npm run seed -- e1d4a38e5341fe92c606b4d9a39981a8a02d2b1b71b57a678d0dd8cf4283edf2

# 2. Tail the live firehose to accumulate new batches as they settle
npm run ingest        # leave running

# 3. Serve the UI (separate terminal)
npm run serve         # http://localhost:8080
```

Operators: `https://arkade.computer` (mainnet) · `https://mutinynet.arkade.sh` (testnet).

## Layout

| File | Role |
|---|---|
| `src/arkade.js` | REST + SSE client over the operator/indexer API |
| `src/db.js`     | `node:sqlite` schema + queries |
| `src/ingest.js` | SSE worker (`--seed <txid…>` to backfill) |
| `src/server.js` | `/api/stats`, `/api/batches`, `/api/batch/:txid` + static UI |
| `public/`       | single-page UI (list, detail, SVG tree) |
| `public/scriptasm.js` | pure Bitcoin Script disassembler (esplora/mempool ASM convention) |

## Known limits (PoC scope)

- **Discovery is realtime-only.** `/v1/txs` has no history; the explorer only sees batches
  that settle while the worker runs (plus anything seeded). A production build would also
  watch commitment txs onchain to backfill history.
- **Internal tree-node amounts** are not shown — only leaf amounts (via `getVtxos`). Intermediate
  node values would require decoding the raw virtual txs (`/v1/indexer/virtualTx/{txids}`).
- Mainnet is new, so live batches are currently small (often 1 vtxo). The tree renderer
  fans out for arbitrary widths — see the layout test referenced in the handoff notes.
- No reorg handling, pagination on very wide trees, or auth/rate-limit concerns.

## Deploy to a VPS

See [`deploy/README.md`](deploy/README.md) for a step-by-step setup: two systemd services
(ingest worker + web server) behind Caddy for automatic HTTPS. Both processes share one
SQLite database via `DB_PATH`, and the operator is selected with `ARK_URL`.

## License

[MIT](LICENSE).
