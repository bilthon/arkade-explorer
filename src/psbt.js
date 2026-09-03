// Minimal PSBT reader: pull the unsigned transaction's input outpoints out of a base64 PSBT.
// Arkade forfeit / virtual txs come back as PSBTs; for the bow-tie we only need their inputs.

function varint(buf, p) {
  const n = buf[p.i++];
  if (n < 0xfd) return n;
  if (n === 0xfd) { const v = buf.readUInt16LE(p.i); p.i += 2; return v; }
  if (n === 0xfe) { const v = buf.readUInt32LE(p.i); p.i += 4; return v; }
  const v = Number(buf.readBigUInt64LE(p.i)); p.i += 8; return v;
}

// Returns [{ txid, vout }] for every input of the PSBT's unsigned tx.
export function psbtInputs(base64) {
  const buf = Buffer.from(base64, "base64");
  const p = { i: 5 }; // skip magic "psbt\xff"
  const klen = varint(buf, p); p.i += klen;          // global key (0x00 = unsigned tx)
  const vlen = varint(buf, p);
  const tx = buf.subarray(p.i, p.i + vlen);           // the raw unsigned tx (non-witness)
  const t = { i: 4 };                                 // skip version
  const nin = varint(tx, t);
  const inputs = [];
  for (let k = 0; k < nin; k++) {
    const txid = Buffer.from(tx.subarray(t.i, t.i + 32)).reverse().toString("hex"); t.i += 32;
    const vout = tx.readUInt32LE(t.i); t.i += 4;
    const sl = varint(tx, t); t.i += sl;              // scriptSig (empty in unsigned tx)
    t.i += 4;                                         // sequence
    inputs.push({ txid, vout });
  }
  return inputs;
}
