// Standard Bitcoin opcode names (esplora / mempool.space convention).
// Covers 0x61–0xb9 plus tapscript OP_CHECKSIGADD (0xba).
const OPCODE_NAMES = {
  0x61: "OP_NOP",         0x62: "OP_VER",          0x63: "OP_IF",
  0x64: "OP_NOTIF",       0x65: "OP_VERIF",        0x66: "OP_VERNOTIF",
  0x67: "OP_ELSE",        0x68: "OP_ENDIF",        0x69: "OP_VERIFY",
  0x6a: "OP_RETURN",      0x6b: "OP_TOALTSTACK",   0x6c: "OP_FROMALTSTACK",
  0x6d: "OP_2DROP",       0x6e: "OP_2DUP",         0x6f: "OP_3DUP",
  0x70: "OP_2OVER",       0x71: "OP_2ROT",         0x72: "OP_2SWAP",
  0x73: "OP_IFDUP",       0x74: "OP_DEPTH",        0x75: "OP_DROP",
  0x76: "OP_DUP",         0x77: "OP_NIP",          0x78: "OP_OVER",
  0x79: "OP_PICK",        0x7a: "OP_ROLL",         0x7b: "OP_ROT",
  0x7c: "OP_SWAP",        0x7d: "OP_TUCK",         0x7e: "OP_CAT",
  0x7f: "OP_SUBSTR",      0x80: "OP_LEFT",         0x81: "OP_RIGHT",
  0x82: "OP_SIZE",        0x83: "OP_INVERT",       0x84: "OP_AND",
  0x85: "OP_OR",          0x86: "OP_XOR",          0x87: "OP_EQUAL",
  0x88: "OP_EQUALVERIFY", 0x89: "OP_RESERVED1",    0x8a: "OP_RESERVED2",
  0x8b: "OP_1ADD",        0x8c: "OP_1SUB",         0x8d: "OP_2MUL",
  0x8e: "OP_2DIV",        0x8f: "OP_NEGATE",       0x90: "OP_ABS",
  0x91: "OP_NOT",         0x92: "OP_0NOTEQUAL",    0x93: "OP_ADD",
  0x94: "OP_SUB",         0x95: "OP_MUL",          0x96: "OP_DIV",
  0x97: "OP_MOD",         0x98: "OP_LSHIFT",       0x99: "OP_RSHIFT",
  0x9a: "OP_BOOLAND",     0x9b: "OP_BOOLOR",       0x9c: "OP_NUMEQUAL",
  0x9d: "OP_NUMEQUALVERIFY", 0x9e: "OP_NUMNOTEQUAL", 0x9f: "OP_LESSTHAN",
  0xa0: "OP_GREATERTHAN",  0xa1: "OP_LESSTHANOREQUAL",
  0xa2: "OP_GREATERTHANOREQUAL", 0xa3: "OP_MIN",   0xa4: "OP_MAX",
  0xa5: "OP_WITHIN",      0xa6: "OP_RIPEMD160",    0xa7: "OP_SHA1",
  0xa8: "OP_SHA256",      0xa9: "OP_HASH160",      0xaa: "OP_HASH256",
  0xab: "OP_CODESEPARATOR", 0xac: "OP_CHECKSIG",   0xad: "OP_CHECKSIGVERIFY",
  0xae: "OP_CHECKMULTISIG", 0xaf: "OP_CHECKMULTISIGVERIFY",
  0xb0: "OP_NOP1",        0xb1: "OP_CHECKLOCKTIMEVERIFY",
  0xb2: "OP_CHECKSEQUENCEVERIFY", 0xb3: "OP_NOP4", 0xb4: "OP_NOP5",
  0xb5: "OP_NOP6",        0xb6: "OP_NOP7",         0xb7: "OP_NOP8",
  0xb8: "OP_NOP9",        0xb9: "OP_NOP10",        0xba: "OP_CHECKSIGADD",
};

// Disassemble a Bitcoin script (lowercase hex string) into ASM tokens,
// using the esplora / mempool.space naming convention. Never throws.
// Returns { tokens, asm }:
//   tokens: ordered array of
//     { type: 'op',   text: 'OP_PUSHBYTES_32' } |
//     { type: 'data', hex:  '98d7…' }
//   asm: the full space-joined string.
export function disasmScript(hex) {
  const tokens = [];
  const op = (text) => tokens.push({ type: "op", text });
  const data = (h) => tokens.push({ type: "data", hex: h });

  // Normalize: strip whitespace, drop a trailing nibble (odd length).
  const clean = (hex || "").replace(/\s+/g, "");
  const usable = clean.length - (clean.length % 2);
  const len = usable / 2; // number of whole bytes
  const byteAt = (i) => parseInt(clean.substr(i * 2, 2), 16);
  const sliceHex = (start, count) => clean.substr(start * 2, count * 2);

  let i = 0;
  while (i < len) {
    const b = byteAt(i);
    i += 1;

    if (b === 0x00) {
      op("OP_0");
    } else if (b >= 0x01 && b <= 0x4b) {
      // Direct push of b bytes.
      op(`OP_PUSHBYTES_${b}`);
      const avail = Math.min(b, len - i);
      if (avail > 0) data(sliceHex(i, avail));
      i += b; // may run past end -> loop ends
    } else if (b === 0x4c || b === 0x4d || b === 0x4e) {
      // OP_PUSHDATA1/2/4: length is little-endian over 1/2/4 bytes.
      const nLenBytes = b === 0x4c ? 1 : b === 0x4d ? 2 : 4;
      op(`OP_PUSHDATA${nLenBytes === 4 ? "4" : nLenBytes}`);
      if (len - i < nLenBytes) break; // truncated length field
      let n = 0;
      for (let k = 0; k < nLenBytes; k++) n += byteAt(i + k) * 2 ** (8 * k);
      i += nLenBytes;
      const avail = Math.min(n, len - i);
      if (avail > 0) data(sliceHex(i, avail));
      i += n;
    } else if (b === 0x4f) {
      op("OP_PUSHNUM_NEG1");
    } else if (b === 0x50) {
      op("OP_RESERVED");
    } else if (b >= 0x51 && b <= 0x60) {
      op(`OP_PUSHNUM_${b - 0x50}`);
    } else if (OPCODE_NAMES[b]) {
      op(OPCODE_NAMES[b]);
    } else {
      op(`OP_UNKNOWN_${b.toString(16).padStart(2, "0")}`);
    }
  }

  return { tokens, asm: tokens.map((t) => (t.type === "op" ? t.text : t.hex)).join(" ") };
}
