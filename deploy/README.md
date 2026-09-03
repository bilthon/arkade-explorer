# Deploying to a VPS (systemd + Caddy)

This runs the explorer as **two systemd services** — an ingest worker that tails the
operator's live firehose, and a web server that renders — behind **Caddy** for automatic
HTTPS. Both services share one SQLite database at `/var/lib/arkade-explorer/data.db`.

Assumes a Debian/Ubuntu VPS with `systemd`. Adjust package commands for other distros.

## 1. Install Node (22 or newer)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
command -v node   # note this path — used by the service files below
```

If `node` is not at `/usr/bin/node`, edit `ExecStart=` in both `.service` files to match.

## 2. Create the service user and lay down the code

```bash
sudo useradd --system --home /opt/arkade-explorer --shell /usr/sbin/nologin arkade
sudo git clone https://github.com/bilthon/arkade-explorer.git /opt/arkade-explorer
sudo chown -R arkade:arkade /opt/arkade-explorer
```

There is nothing to build or `npm install` — the app is zero-dependency.

## 3. Install the systemd services

```bash
sudo cp /opt/arkade-explorer/deploy/arkade-explorer-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now arkade-explorer-ingest.service
sudo systemctl enable --now arkade-explorer-serve.service
```

`StateDirectory=arkade-explorer` makes systemd create and own `/var/lib/arkade-explorer`
automatically, so the shared `data.db` lands there.

Check both are healthy:

```bash
systemctl status arkade-explorer-serve.service
journalctl -u arkade-explorer-ingest.service -f    # watch batches stream in
curl -s localhost:8080/api/stats                   # should return JSON
```

The `serve` unit defaults to the **mainnet** operator (`https://arkade.computer`). To point
at mutinynet instead, change `ARK_URL` in **both** unit files and `daemon-reload` + restart.

## 4. Front it with Caddy (automatic HTTPS)

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

Point a DNS `A`/`AAAA` record at the VPS, then edit the domain in the Caddyfile and install it:

```bash
sudo cp /opt/arkade-explorer/deploy/Caddyfile /etc/caddy/Caddyfile
sudo $EDITOR /etc/caddy/Caddyfile     # replace explorer.example.com with your domain
sudo systemctl reload caddy
```

Caddy provisions a Let's Encrypt certificate on first request. Visit `https://your-domain`.

## 5. Keep fees, sweep status, and bow-tie inputs current (maintenance timer)

Three things need catch-up after ingest: a commitment's **fee** may be unconfirmed when first
seen, a batch's **swept** status only flips later (once its VTXO tree expires and is reclaimed),
and the bow-tie **input VTXOs** can be missed on a transient indexer error (or on any batch
ingested before the feature shipped). A systemd timer runs all three catch-up passes
(`--backfill-fees`, `--refresh-sweeps`, `--backfill-inputs`) every 30 minutes so the explorer
stays current with zero manual steps.

```bash
sudo cp /opt/arkade-explorer/deploy/arkade-explorer-maintenance.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now arkade-explorer-maintenance.timer
```

Check it:

```bash
systemctl list-timers arkade-explorer-maintenance.timer   # next/last run
journalctl -u arkade-explorer-maintenance.service -f      # watch a pass
```

Without this timer the deployed explorer would show every batch as `live` forever, leave
late-confirming fees blank, and drop the bow-tie on any batch whose inputs failed the first
try — the passes are what keep those columns and diagrams trustworthy.

## Updating

```bash
sudo -u arkade git -C /opt/arkade-explorer pull
sudo systemctl restart arkade-explorer-ingest.service arkade-explorer-serve.service
```

Node caches modules at process start, so **both services must be restarted** to pick up any
`src/` change — otherwise the server keeps serving the old API shape and the worker keeps
ingesting with the old logic (e.g. new batches landing without their bow-tie inputs).

When an update adds a new per-batch field (fees, sweep status, and bow-tie inputs each did),
**existing rows are filled in retroactively** — automatically by the maintenance timer within
30 minutes, or immediately with a one-off pass. For the bow-tie inputs:

```bash
sudo -u arkade ARK_URL=https://arkade.computer DB_PATH=/var/lib/arkade-explorer/data.db \
  node --experimental-sqlite /opt/arkade-explorer/src/ingest.js --backfill-inputs
```

If the maintenance `.service` file itself changed (e.g. to add the `--backfill-inputs` pass),
re-copy it and reload:

```bash
sudo cp /opt/arkade-explorer/deploy/arkade-explorer-maintenance.service /etc/systemd/system/
sudo systemctl daemon-reload
```

## Notes

- **Backfill.** Discovery is realtime-only, so the explorer only accumulates batches that
  settle while the ingest worker runs. To seed known commitments up front:
  `sudo -u arkade DB_PATH=/var/lib/arkade-explorer/data.db \
   node --experimental-sqlite /opt/arkade-explorer/src/ingest.js --seed <txid>...`
- **On-chain fees (external dependency).** The ingest worker also queries an esplora block
  explorer (`mempool.space` by default) for each commitment's miner fee, so it needs
  outbound HTTPS **beyond** the Arkade operator. The base URL is network-aware
  (mainnet → `https://mempool.space/api`, mutinynet → `https://mutinynet.com/api`); override
  with `ESPLORA_URL=` in the ingest unit. Commitments that aren't found on-chain (unconfirmed,
  dropped, or RBF-replaced) simply show no fee and are excluded from totals. To price rows
  that were captured while esplora was unreachable or still unconfirmed:
  `sudo -u arkade DB_PATH=/var/lib/arkade-explorer/data.db ARK_URL=https://arkade.computer \
   node --experimental-sqlite /opt/arkade-explorer/src/ingest.js --backfill-fees`
- **Bow-tie inputs (extra indexer calls).** Reconstructing each batch's input VTXOs adds a few
  indexer round-trips per commitment (`forfeitTxs` → virtual tx → `vtxos`). The `--backfill-inputs`
  pass is network-filtered: it only touches rows whose `network` matches the operator in `ARK_URL`,
  so it's safe on a single-network deployment and won't poison rows from another network.
- **Firewall.** Only 80/443 need to be public (Caddy). The app's own port 8080 can stay
  bound to localhost — it already is, via the reverse proxy.
- **Reset the data.** Stop both services, delete `/var/lib/arkade-explorer/data.db`, start again.
