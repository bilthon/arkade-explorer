import { disasmScript } from "/scriptasm.js";

const $ = (s) => document.querySelector(s);
// Off-chain (virtual) txs in the VTXO tree link out to the Arkade explorer.
// Change the host if you point this explorer at a different network.
const ARK_EXPLORER = "https://explorer.arkade.sh";
const short = (h) => (h ? h.slice(0, 10) + "…" + h.slice(-6) : "");
const sats = (n) => Number(n || 0).toLocaleString() + " sats";
const when = (t) => (t ? new Date(t * 1000).toLocaleString() : "—");

async function api(p) {
  const r = await fetch(p);
  if (!r.ok) throw new Error(p + " " + r.status);
  return r.json();
}

let toastTimer;
function toast(msg) {
  let t = $("#toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1100);
}

// Click-to-copy for any element carrying data-copy. Capture phase + stopPropagation so a
// copy target inside a clickable list row copies instead of navigating to the batch.
document.addEventListener(
  "click",
  (e) => {
    const el = e.target.closest?.("[data-copy]");
    if (!el) return;
    e.stopPropagation();
    e.preventDefault();
    const text = el.getAttribute("data-copy");
    navigator.clipboard?.writeText(text).then(
      () => toast("Copied " + (text.length > 22 ? short(text) : text)),
      () => toast("Copy failed"),
    );
  },
  true,
);

// Classify a batch's VTXO flow. We only have net totals (output − input), so we can be *exact*
// only when one side has zero value — a pure onboard (no inputs) or pure offboard (no outputs).
// With VTXOs on both sides the gross split is unrecoverable, so we report just the net direction.
function flowOf(b) {
  const i = b.total_input_amount, o = b.total_output_amount;
  if (i == null || o == null) return null;
  if (i === 0 && o > 0) return { label: "onboard", sign: "+", amt: o, dir: "in", pure: true };
  if (o === 0 && i > 0) return { label: "offboard", sign: "−", amt: i, dir: "out", pure: true };
  const d = o - i;
  if (d === 0) return { label: "renewal", dir: "flat" };
  if (d > 0) return { label: "net in", sign: "+", amt: d, dir: "in", pure: false };
  return { label: "net out", sign: "−", amt: -d, dir: "out", pure: false };
}
function flowPill(b) {
  const f = flowOf(b);
  if (!f) return '<span class="badge">—</span>';
  if (f.dir === "flat") return '<span class="badge" title="net VTXO flow balanced (renewal)">renewal</span>';
  const cls = f.dir === "in" ? "onboard" : "offboard";
  const title = f.pure
    ? `pure ${f.label} — no VTXOs on the other side, so this amount is exact`
    : "net VTXO flow — a batch can mix onboard/offboard/renewal; only the net is exposed";
  return `<span class="badge ${cls}" title="${title}">${f.label} ${f.sign}${f.amt.toLocaleString()}</span>`;
}

// Aggregate flow bar (from /api/stats counts), shown above the batch list. Classified by net,
// so the onboard/offboard buckets are labelled "net in" / "net out" to stay honest.
function renderFlowBar(s) {
  const el = $("#flow-summary");
  if (!el) return;
  const r = s.renewals || 0, on = s.onboards || 0, off = s.offboards || 0, tot = r + on + off;
  if (!tot) { el.innerHTML = ""; return; }
  const pct = (n) => ((n / tot) * 100).toFixed(1);
  const seg = (cls, n) => `<span class="seg ${cls}" style="width:${pct(n)}%"></span>`;
  const leg = (cls, label, n) => `<span><i class="dot ${cls}"></i>${label} ${n.toLocaleString()} (${pct(n)}%)</span>`;
  el.innerHTML =
    `<div class="flowbar" title="batches by net VTXO flow">${seg("renewal", r)}${seg("onboard", on)}${seg("offboard", off)}</div>` +
    `<div class="flowlegend">${leg("renewal", "renewal", r)}${leg("onboard", "net in", on)}${leg("offboard", "net out", off)}</div>`;
}

async function loadStats() {
  try {
    const s = await api("/api/stats");
    $("#stats").innerHTML =
      `<span>operator <b>${s.operator.replace(/^https?:\/\//, "")}</b></span>` +
      `<span>batches <b>${s.batches}</b></span>` +
      `<span>vtxos <b>${s.vtxos}</b></span>` +
      `<span>volume <b>${sats(s.sats)}</b></span>` +
      `<span>fees <b>${sats(s.fees)}</b></span>`;
    renderFlowBar(s);
  } catch {}
}

const PAGE_SIZE = 25;
let page = 1;

async function loadList() {
  const data = await api(`/api/batches?page=${page}&limit=${PAGE_SIZE}`);
  const rows = data.batches || [];
  const total = data.total || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (page > pages) { page = pages; return loadList(); } // clamp if the dataset shrank under us
  const body = $("#batches-body");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">waiting for batches… run the ingest worker</td></tr>`;
    renderPager(total, pages);
    return;
  }
  body.innerHTML = "";
  for (const b of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="mono txid">${short(b.txid)}<span class="copy" data-copy="${b.txid}" title="Copy txid">⧉</span></td>` +
      `<td>${when(b.started_at)}</td>` +
      `<td class="num">${b.total_output_vtxos}</td>` +
      `<td class="num">${sats(b.total_output_amount)}</td>` +
      `<td class="num">${b.fee != null ? sats(b.fee) : "—"}</td>` +
      `<td>${b.swept ? '<span class="badge swept">swept</span>' : '<span class="badge live">live</span>'}</td>` +
      `<td>${flowPill(b)}</td>`;
    tr.onclick = () => showDetail(b.txid);
    body.appendChild(tr);
  }
  renderPager(total, pages);
}

// Prev/Next pager under the list. Hidden entirely when everything fits on one page.
function renderPager(total, pages) {
  const el = $("#pager");
  if (!el) return;
  if (total <= PAGE_SIZE) { el.innerHTML = ""; return; }
  el.innerHTML =
    `<button id="prev" ${page <= 1 ? "disabled" : ""}>← prev</button>` +
    `<span class="pageinfo">page ${page} of ${pages} · ${total.toLocaleString()} batches</span>` +
    `<button id="next" ${page >= pages ? "disabled" : ""}>next →</button>`;
  $("#prev").onclick = () => { if (page > 1) { page--; loadList(); } };
  $("#next").onclick = () => { if (page < pages) { page++; loadList(); } };
}

function card(k, v) {
  return `<div class="card"><div class="k">${k}</div><div class="v">${v}</div></div>`;
}

// On-chain fee amortized over the batch's vtxos — Arkade's efficiency story. A ~170-sat
// commitment over 1 vtxo is 170 sats each; over 100 vtxos it's ~1.7 sats each.
function costPerVtxo(b, c) {
  const n = c.totalOutputVtxos ?? b.total_output_vtxos;
  if (b.fee == null || !n) return "—";
  return (b.fee / n).toFixed(1) + " sats";
}

// Build a tidy top-down layout from {txid, children:{outIdx:childTxid}} nodes.
function renderTree(batch) {
  const nodes = batch.nodes || [];
  if (!nodes.length) return '<p class="hint">no tree nodes</p>';
  const byId = new Map(nodes.map((n) => [n.txid, n]));
  const childIds = new Set();
  for (const n of nodes) for (const c of Object.values(n.children || {})) childIds.add(c);
  const roots = nodes.filter((n) => !childIds.has(n.txid));

  // assign depth + x via DFS over leaves
  const pos = new Map();
  let leafX = 0;
  const W = 150, H = 64, BW = 132, BH = 30;
  function dfs(id, depth) {
    const n = byId.get(id);
    const kids = n ? Object.values(n.children || {}).filter((c) => byId.has(c)) : [];
    let x;
    if (!kids.length) {
      x = leafX++ * W + W / 2;
    } else {
      const xs = kids.map((k) => dfs(k, depth + 1));
      x = (Math.min(...xs) + Math.max(...xs)) / 2;
    }
    pos.set(id, { x, y: depth * H + 24, isLeaf: !kids.length, isRoot: depth === 0 });
    return x;
  }
  roots.forEach((r) => dfs(r.txid, 0));

  let maxX = 0, maxY = 0;
  for (const p of pos.values()) { maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const width = Math.max(maxX + W, 320), height = maxY + H;

  let edges = "", boxes = "";
  for (const n of nodes) {
    const p = pos.get(n.txid);
    for (const c of Object.values(n.children || {})) {
      const cp = pos.get(c);
      if (!cp) continue;
      const x1 = p.x, y1 = p.y + BH, x2 = cp.x, y2 = cp.y;
      const my = (y1 + y2) / 2;
      edges += `<path class="edge" d="M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}"/>`;
    }
  }
  for (const [id, p] of pos) {
    const cls = p.isRoot ? "root" : p.isLeaf ? "leaf" : "";
    boxes +=
      `<a href="${ARK_EXPLORER}/tx/${id}" target="_blank" rel="noopener noreferrer">` +
      `<g class="node ${cls}"><title>${id} — open in Arkade explorer</title>` +
      `<rect x="${p.x - BW / 2}" y="${p.y}" width="${BW}" height="${BH}" rx="5"/>` +
      `<text x="${p.x}" y="${p.y + 19}" text-anchor="middle">${short(id)}</text></g></a>`;
  }
  return `<div class="tree-wrap"><svg width="${width}" height="${height}">${edges}${boxes}</svg></div>`;
}

// Bow-tie: input VTXOs (reconstructed from forfeits) → commitment → output VTXOs (leaves).
// Onboards appear as an output with no matching input, offboards as an input with no output;
// the net difference is balanced with an "on-chain" stub. Ribbon thickness ∝ amount, and
// styling encodes the layer: solid = on-chain/settled, dashed = off-chain/virtual VTXO flows.
function renderBowtie(b) {
  const ins = (b.input_leaves_json || []).map((l) => ({ amt: Number(l.amount || 0), op: `${l.txid}:${l.vout}`, kind: "vtxo" }));
  const outs = [];
  for (const set of b.leaves_json || []) for (const l of set.leaves || []) outs.push({ amt: Number(l.amount || 0), op: `${l.txid}:${l.vout}`, kind: "vtxo" });
  if (!ins.length && !outs.length) return "";
  // Guard: if the indexer reports input VTXOs but none were reconstructed yet (row not
  // backfilled), skip — otherwise it would render misleadingly as a pure onboard.
  if (Number(b.total_input_amount || 0) > 0 && !ins.length) return "";
  const sumIn = ins.reduce((a, x) => a + x.amt, 0);
  const sumOut = outs.reduce((a, x) => a + x.amt, 0);
  const net = sumOut - sumIn;
  if (net > 0) ins.push({ amt: net, op: "net onboarded from on-chain", kind: "chain" });
  if (net < 0) outs.push({ amt: -net, op: "net offboarded to on-chain", kind: "chain" });
  const total = Math.max(sumIn, sumOut, 1);

  const W = 640, boxW = 150, boxH = 26, vgap = 12, padY = 18;
  const rows = Math.max(ins.length, outs.length);
  const H = Math.max(140, padY * 2 + rows * boxH + (rows - 1) * vgap);
  const leftX = 8, rightX = W - boxW - 8, cx = W / 2, cw = 96, ch = 34, cyc = H / 2;
  const yFor = (i, n) => { const blk = n * boxH + (n - 1) * vgap; return (H - blk) / 2 + i * (boxH + vgap); };
  const rw = (amt) => Math.max(1.5, (amt / total) * 16);

  let ribbons = "", boxes = "";
  ins.forEach((n, i) => {
    const y = yFor(i, ins.length) + boxH / 2, x1 = leftX + boxW, x2 = cx - cw / 2, mx = (x1 + x2) / 2;
    ribbons += `<path class="ribbon in ${n.kind}" d="M${x1},${y} C${mx},${y} ${mx},${cyc} ${x2},${cyc}" stroke-width="${rw(n.amt)}"/>`;
  });
  outs.forEach((n, i) => {
    const y = yFor(i, outs.length) + boxH / 2, x1 = cx + cw / 2, x2 = rightX, mx = (x1 + x2) / 2;
    ribbons += `<path class="ribbon out ${n.kind}" d="M${x1},${cyc} C${mx},${cyc} ${mx},${y} ${x2},${y}" stroke-width="${rw(n.amt)}"/>`;
  });
  const node = (x, i, n, count) => {
    const y = yFor(i, count);
    const label = n.kind === "chain" ? "on-chain" : n.amt.toLocaleString() + " sats";
    return `<g class="bt-node ${n.kind}"><title>${n.op}</title>` +
      `<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="5"/>` +
      `<text x="${x + boxW / 2}" y="${y + boxH / 2}" text-anchor="middle">${label}</text></g>`;
  };
  ins.forEach((n, i) => (boxes += node(leftX, i, n, ins.length)));
  outs.forEach((n, i) => (boxes += node(rightX, i, n, outs.length)));
  boxes += `<g class="bt-center"><rect x="${cx - cw / 2}" y="${cyc - ch / 2}" width="${cw}" height="${ch}" rx="5"/>` +
    `<text x="${cx}" y="${cyc}" text-anchor="middle">commitment</text></g>`;

  const legend =
    `<div class="bt-legend">` +
    `<span><i class="line on"></i>on-chain (settled)</span>` +
    `<span><i class="line dash in"></i>input VTXO (forfeited)</span>` +
    `<span><i class="line dash out"></i>output VTXO (created)</span>` +
    `<span class="lg-note">ribbon width ∝ amount</span>` +
    `</div>`;
  return `<h2>value flow</h2><div class="bowtie-wrap"><svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${ribbons}${boxes}</svg>` +
    legend +
    `<small class="hint">inputs (forfeited VTXOs) ${sats(sumIn)} → outputs (VTXOs) ${sats(sumOut)}</small></div>`;
}

// Script column: raw hex (copyable) stacked over disassembled ASM (copyable),
// with long data pushes ellipsized for readability. esplora/mempool ASM convention.
function scriptCell(hex) {
  const { tokens, asm } = disasmScript(hex);
  const pretty = tokens
    .map((t) =>
      t.type === "op"
        ? `<span class="op">${t.text}</span>`
        : `<span class="data">${t.hex.length > 20 ? short(t.hex) : t.hex}</span>`,
    )
    .join(" ");
  return (
    `<td class="mono script-cell">` +
    `<div class="hex copyable" data-copy="${hex}" title="Click to copy hex">${short(hex)}</div>` +
    `<div class="asm copyable" data-copy="${asm}" title="Click to copy ASM">${pretty}</div>` +
    `</td>`
  );
}

function renderLeaves(set) {
  const ls = set.leaves || [];
  if (!ls.length) return '<p class="hint">leaf amounts not resolved (already spent/swept on this batch)</p>';
  const total = ls.reduce((n, l) => n + Number(l.amount || 0), 0);
  const rows = ls
    .map(
      (l) =>
        `<tr><td class="mono copyable" data-copy="${l.txid}:${l.vout}" title="Click to copy">${short(l.txid)}:${l.vout}</td>` +
        `<td class="amt num">${sats(l.amount)}</td>` +
        scriptCell(l.script) +
        `<td>${l.isSpent ? '<span class="badge">spent</span>' : '<span class="badge live">live</span>'}</td></tr>`,
    )
    .join("");
  return (
    `<table class="leaves"><thead><tr><th>vtxo outpoint</th><th class="num">amount</th><th>scriptPubKey (hex / ASM)</th><th></th></tr></thead>` +
    `<tbody>${rows}</tbody>` +
    `<tfoot><tr><td><b>${ls.length} vtxos</b></td><td class="amt num"><b>${sats(total)}</b></td><td colspan="2"></td></tr></tfoot></table>`
  );
}

async function showDetail(txid) {
  location.hash = "batch/" + txid;
  const b = await api("/api/batch/" + txid);
  $("#list-pane").hidden = true;
  $("#detail-pane").hidden = false;
  const c = b.commitment_json || {};
  let html =
    `<h2>commitment</h2><div class="mono txid copyable" data-copy="${txid}" title="Click to copy" style="margin-bottom:16px;word-break:break-all">${txid}</div>` +
    `<div class="summary">` +
    card("input vtxos", `${c.totalInputVtxos ?? "—"} · ${sats(b.total_input_amount)}`) +
    card("output vtxos", `${c.totalOutputVtxos ?? b.total_output_vtxos} · ${sats(b.total_output_amount)}`) +
    card("fee", b.fee != null ? `${sats(b.fee)} · ${b.feerate != null ? b.feerate.toFixed(2) + " sat/vB" : "—"}` : "—") +
    card("cost / vtxo", costPerVtxo(b, c)) +
    card("started", when(b.started_at)) +
    card("duration", b.ended_at && b.started_at ? b.ended_at - b.started_at + "s" : "—") +
    card("block", b.block_height != null ? "#" + b.block_height.toLocaleString() : "unconfirmed") +
    card("status", b.swept ? "swept" : "live") +
    `</div>`;

  html += renderBowtie(b);

  b.tree_json.forEach((batch, i) => {
    const leafSet = b.leaves_json[i] || { leaves: [] };
    html +=
      `<h2>batch output #${batch.outpoint.vout} — VTXO tree (${batch.info?.totalOutputVtxos ?? "?"} vtxos${batch.info?.swept ? ", swept" : ""})</h2>` +
      renderTree(batch) +
      renderLeaves(leafSet);
  });
  $("#detail").innerHTML = html;
}

$("#back").onclick = () => {
  location.hash = "";
  $("#detail-pane").hidden = true;
  $("#list-pane").hidden = false;
};

await loadStats();
await loadList();
const m = location.hash.match(/^#batch\/([0-9a-f]{64})/i);
if (m) showDetail(m[1]).catch(() => {});
setInterval(() => {
  if ($("#list-pane").hidden === false) {
    loadStats();
    if (page === 1) loadList(); // keep the newest page live; leave deeper pages stable while browsing
  }
}, 5000);
