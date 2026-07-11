/* =============================================================================
 * qr.js — a small, correct, dependency-free QR encoder (byte mode).
 *
 * Enough of the QR spec to encode a URL: versions 1–10, all four EC levels,
 * Reed–Solomon error correction, block interleaving, the eight data masks with
 * penalty scoring, and format/version information. Exposes:
 *
 *   QR.matrix(text, { ecl })  -> { size, modules:boolean[][], version }
 *   QR.svg(text, { ecl, scale, quiet, dark, light }) -> SVG string
 *
 * Output is verified to decode with an independent reader (see qr.test.mjs).
 * ========================================================================== */
(function (root) {
  'use strict';

  // ---- Galois field GF(256) with primitive polynomial 0x11d -----------------
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= gmul(poly[j], EXP[i]);
        next[j + 1] ^= poly[j];
      }
      poly = next;
    }
    return poly.reverse();   // leading (highest-degree) term first, so gen[0] === 1
  }
  function rsEncode(data, ecLen) {
    const gen = rsGenerator(ecLen);   // degree ecLen, gen[0] === 1 (leading term)
    const res = new Array(ecLen).fill(0);
    for (const d of data) {
      const factor = d ^ res[0];
      res.shift(); res.push(0);
      for (let j = 0; j < ecLen; j++) res[j] ^= gmul(gen[j + 1], factor);
    }
    return res;
  }

  // ---- capacity + EC block tables (versions 1..10) --------------------------
  // total data codewords per (version, ecl); ecl order: L,M,Q,H
  const DATA_CW = {
    1: [19, 16, 13, 9], 2: [34, 28, 22, 16], 3: [55, 44, 34, 26], 4: [80, 64, 48, 36],
    5: [108, 86, 62, 46], 6: [136, 108, 76, 60], 7: [156, 124, 88, 66], 8: [194, 154, 110, 86],
    9: [232, 182, 132, 100], 10: [274, 216, 154, 122],
  };
  // EC codewords per block, then block structure [ [count, dataCwPerBlock], ... ]
  const EC_BLOCKS = {
    // version: { L:[ecPerBlock, blocks...], M, Q, H }
    1: { L: [7, [[1, 19]]], M: [10, [[1, 16]]], Q: [13, [[1, 13]]], H: [17, [[1, 9]]] },
    2: { L: [10, [[1, 34]]], M: [16, [[1, 28]]], Q: [22, [[1, 22]]], H: [28, [[1, 16]]] },
    3: { L: [15, [[1, 55]]], M: [26, [[1, 44]]], Q: [18, [[2, 17]]], H: [22, [[2, 13]]] },
    4: { L: [20, [[1, 80]]], M: [18, [[2, 32]]], Q: [26, [[2, 24]]], H: [16, [[4, 9]]] },
    5: { L: [26, [[1, 108]]], M: [24, [[2, 43]]], Q: [18, [[2, 15], [2, 16]]], H: [22, [[2, 11], [2, 12]]] },
    6: { L: [18, [[2, 68]]], M: [16, [[4, 27]]], Q: [24, [[4, 19]]], H: [28, [[4, 15]]] },
    7: { L: [20, [[2, 78]]], M: [18, [[4, 31]]], Q: [18, [[2, 14], [4, 15]]], H: [26, [[4, 13], [1, 14]]] },
    8: { L: [24, [[2, 97]]], M: [22, [[2, 38], [2, 39]]], Q: [22, [[4, 18], [2, 19]]], H: [26, [[4, 14], [2, 15]]] },
    9: { L: [30, [[2, 116]]], M: [22, [[3, 36], [2, 37]]], Q: [20, [[4, 16], [4, 17]]], H: [24, [[4, 12], [4, 13]]] },
    10: { L: [18, [[2, 68], [2, 69]]], M: [26, [[4, 43], [1, 44]]], Q: [24, [[6, 19], [2, 20]]], H: [28, [[6, 15], [2, 16]]] },
  };
  const ECL_IDX = { L: 0, M: 1, Q: 2, H: 3 };
  // alignment pattern centre coordinates by version
  const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

  function pickVersion(byteLen, ecl) {
    for (let v = 1; v <= 10; v++) {
      const cci = v < 10 ? 8 : 16;                    // char-count bits for byte mode (v1-9: 8, v10+: 16)
      const bits = 4 + cci + byteLen * 8;
      if (Math.ceil(bits / 8) <= DATA_CW[v][ECL_IDX[ecl]]) return v;
    }
    throw new Error('QR: text too long for version ≤ 10');
  }

  // ---- bit buffer -----------------------------------------------------------
  function toDataCodewords(bytes, version, ecl) {
    const totalData = DATA_CW[version][ECL_IDX[ecl]];
    const bitsCap = totalData * 8;
    const cci = version < 10 ? 8 : 16;
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    put(0b0100, 4);                                   // byte mode
    put(bytes.length, cci);
    for (const b of bytes) put(b, 8);
    // terminator + pad to byte boundary
    for (let i = 0; i < 4 && bits.length < bitsCap; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    const cw = [];
    for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; cw.push(v); }
    const PADS = [0xec, 0x11];
    let p = 0;
    while (cw.length < totalData) { cw.push(PADS[p & 1]); p++; }
    return cw;
  }

  function interleave(dataCw, version, ecl) {
    const [ecPerBlock, structure] = EC_BLOCKS[version][ecl];
    const blocks = [];
    let idx = 0;
    for (const [count, dataLen] of structure) {
      for (let b = 0; b < count; b++) {
        const d = dataCw.slice(idx, idx + dataLen); idx += dataLen;
        blocks.push({ data: d, ec: rsEncode(d, ecPerBlock) });
      }
    }
    const maxData = Math.max(...blocks.map((b) => b.data.length));
    const out = [];
    for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
    for (let i = 0; i < ecPerBlock; i++) for (const b of blocks) out.push(b.ec[i]);
    return out;
  }

  // ---- matrix construction --------------------------------------------------
  function buildMatrix(finalCw, version) {
    const size = version * 4 + 17;
    const mods = Array.from({ length: size }, () => new Array(size).fill(null)); // null=free
    const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (r, c, v) => { mods[r][c] = v ? 1 : 0; reserved[r][c] = true; };

    // finder + separators
    const finder = (r, c) => {
      for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
        const rr = r + i, cc = c + j; if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inRing = i >= 0 && i <= 6 && j >= 0 && j <= 6;
        const dark = inRing && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4));
        set(rr, cc, dark ? 1 : 0);
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    // timing patterns
    for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0 ? 1 : 0); set(i, 6, i % 2 === 0 ? 1 : 0); }

    // alignment patterns
    const centres = ALIGN[version];
    for (const r of centres) for (const c of centres) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
        const dark = Math.max(Math.abs(i), Math.abs(j)) !== 1;
        set(r + i, c + j, dark ? 1 : 0);
      }
    }

    // dark module + reserve format/version areas
    set(size - 8, 8, 1);
    const reserveFormat = () => {
      for (let i = 0; i <= 8; i++) { if (i !== 6) { reserved[8][i] = true; reserved[i][8] = true; } }
      for (let i = 0; i < 8; i++) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true; }
      reserved[8][8] = true;
    };
    reserveFormat();
    if (version >= 7) {
      for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { reserved[i][size - 11 + j] = true; reserved[size - 11 + j][i] = true; }
    }

    // data placement (zigzag, upward/downward columns skipping column 6)
    let bitIdx = 0;
    const bitsArr = [];
    for (const cw of finalCw) for (let i = 7; i >= 0; i--) bitsArr.push((cw >> i) & 1);
    let up = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;                            // skip vertical timing column
      for (let k = 0; k < size; k++) {
        const row = up ? size - 1 - k : k;
        for (let c = 0; c < 2; c++) {
          const cc = col - c;
          if (reserved[row][cc]) continue;
          mods[row][cc] = bitIdx < bitsArr.length ? bitsArr[bitIdx] : 0;
          bitIdx++;
        }
      }
      up = !up;
    }
    return { size, mods, reserved };
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function applyMask(mods, reserved, maskFn) {
    const size = mods.length;
    const out = mods.map((row) => row.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!reserved[r][c] && maskFn(r, c)) out[r][c] ^= 1;
    return out;
  }

  function penalty(mods) {
    const size = mods.length; let score = 0;
    // rule 1: runs of 5+ same colour
    for (let r = 0; r < size; r++) {
      let run = 1;
      for (let c = 1; c < size; c++) { if (mods[r][c] === mods[r][c - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; } else run = 1; }
    }
    for (let c = 0; c < size; c++) {
      let run = 1;
      for (let r = 1; r < size; r++) { if (mods[r][c] === mods[r - 1][c]) { run++; if (run === 5) score += 3; else if (run > 5) score += 1; } else run = 1; }
    }
    // rule 2: 2x2 blocks
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
      const v = mods[r][c]; if (v === mods[r][c + 1] && v === mods[r + 1][c] && v === mods[r + 1][c + 1]) score += 3;
    }
    // rule 3: finder-like 1011101 with 4 light on either side
    const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const check = (arr, i) => pat1.every((v, k) => arr[i + k] === v) || pat2.every((v, k) => arr[i + k] === v);
    for (let r = 0; r < size; r++) for (let c = 0; c <= size - 11; c++) { const row = mods[r]; if (check(row, c)) score += 40; }
    for (let c = 0; c < size; c++) { const col = mods.map((row) => row[c]); for (let r = 0; r <= size - 11; r++) if (check(col, r)) score += 40; }
    // rule 4: dark ratio
    let dark = 0; for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += mods[r][c];
    const pct = (dark / (size * size)) * 100;
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  // format info (15 bits) BCH + mask; version info (18 bits) for v>=7.
  const bchDigit = (x) => { let n = 0; while (x !== 0) { n++; x >>>= 1; } return n; };
  function formatBits(ecl, mask) {
    const ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };
    const data = (ECL_BITS[ecl] << 3) | mask;
    let d = data << 10;
    const G15 = 0x537;
    while (bchDigit(d) - bchDigit(G15) >= 0) d ^= (G15 << (bchDigit(d) - bchDigit(G15)));
    return ((data << 10) | d) ^ 0x5412;
  }
  function versionBits(version) {
    let d = version << 12;
    const G18 = 0x1f25;
    while (bchDigit(d) - bchDigit(G18) >= 0) d ^= (G18 << (bchDigit(d) - bchDigit(G18)));
    return (version << 12) | d;
  }

  function placeFormat(mods, ecl, mask) {
    const size = mods.length; const bits = formatBits(ecl, mask);
    for (let i = 0; i < 15; i++) {
      const mod = ((bits >> i) & 1) === 1 ? 1 : 0;
      if (i < 6) mods[i][8] = mod;
      else if (i < 8) mods[i + 1][8] = mod;
      else mods[size - 15 + i][8] = mod;
      if (i < 8) mods[8][size - i - 1] = mod;
      else if (i < 9) mods[8][15 - i - 1 + 1] = mod;
      else mods[8][15 - i - 1] = mod;
    }
    mods[size - 8][8] = 1; // dark module
  }
  function placeVersion(mods, version) {
    if (version < 7) return; const size = mods.length; const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const b = (bits >> i) & 1; const r = Math.floor(i / 3), c = i % 3;
      mods[r][size - 11 + c] = b; mods[size - 11 + c][r] = b;
    }
  }

  function encodeBytes(text) {
    // UTF-8 encode
    return Array.from(new TextEncoder().encode(text));
  }

  function matrix(text, opts) {
    opts = opts || {};
    const ecl = opts.ecl || 'M';
    const bytes = encodeBytes(text);
    const version = pickVersion(bytes.length, ecl);
    const dataCw = toDataCodewords(bytes, version, ecl);
    const finalCw = interleave(dataCw, version, ecl);
    const { size, mods, reserved } = buildMatrix(finalCw, version);
    // choose best mask (or a forced one, for testing)
    let best = null;
    const masksToTry = (opts.forceMask != null) ? [opts.forceMask] : [0, 1, 2, 3, 4, 5, 6, 7];
    for (const m of masksToTry) {
      const masked = applyMask(mods, reserved, MASKS[m]);
      placeFormat(masked, ecl, m);
      placeVersion(masked, version);
      const p = penalty(masked);
      if (!best || p < best.p) best = { p, m, masked };
    }
    return { size, version, mask: best.m, modules: best.masked.map((row) => row.map((v) => v === 1)) };
  }

  function svg(text, opts) {
    opts = opts || {};
    const scale = opts.scale || 4, quiet = opts.quiet == null ? 4 : opts.quiet;
    const dark = opts.dark || '#0d0b08', light = opts.light || '#ffffff';
    const { size, modules } = matrix(text, opts);
    const dim = (size + quiet * 2) * scale;
    let path = '';
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (modules[r][c]) path += `M${(c + quiet) * scale} ${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
  }

  const QR = { matrix, svg };
  if (typeof module !== 'undefined' && module.exports) module.exports = QR;
  else root.QR = QR;
})(typeof window !== 'undefined' ? window : globalThis);
