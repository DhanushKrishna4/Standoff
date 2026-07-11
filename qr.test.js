/* =============================================================================
 * qr.test.js — regression tests for the QR encoder (qr.js).
 *
 * The real proof of correctness is a round-trip: qr.js output was decoded with an
 * independent reader (jsQR) across every EC level and versions 1–10 — see the
 * commit notes. That can't run here without a dependency, so this locks the
 * encoder's behaviour with structural invariants + a golden fingerprint, so any
 * regression in the (bug-prone) Reed–Solomon / masking / placement code trips a test.
 *
 *   node qr.test.js
 * ========================================================================== */
'use strict';
const assert = require('assert');
const QR = require('./qr.js');

let passed = 0;
const ok = (name) => { passed++; console.log('  \x1b[32m✓\x1b[0m ' + name); };

// --- version selection grows with length + EC level --------------------------
assert.strictEqual(QR.matrix('SHORT', { ecl: 'M' }).version, 1, 'short text is version 1');
assert.ok(QR.matrix('x'.repeat(200), { ecl: 'L' }).version <= 10, 'a long string still fits ≤ v10 at L');
assert.ok(QR.matrix('x'.repeat(60), { ecl: 'H' }).version > QR.matrix('x'.repeat(60), { ecl: 'L' }).version, 'higher EC needs a bigger symbol');
ok('version selection scales with length and error-correction level');

// --- structural invariants ---------------------------------------------------
const m = QR.matrix('https://standoff-liyl.onrender.com/?pick=interstellar', { ecl: 'M' });
assert.strictEqual(m.size, m.version * 4 + 17, 'size matches the version formula');
assert.strictEqual(m.modules.length, m.size, 'matrix is size rows');
assert.ok(m.modules.every((row) => row.length === m.size && row.every((v) => typeof v === 'boolean')), 'every cell is a boolean');
// the three finder patterns: a dark 7×7 ring with a light separator inside at (1,1)
const finder = (r, c) => m.modules[r][c] && m.modules[r + 6][c] && m.modules[r][c + 6] && m.modules[r + 6][c + 6] && !m.modules[r + 1][c + 1];
assert.ok(finder(0, 0) && finder(0, m.size - 7) && finder(m.size - 7, 0), 'all three finder patterns are present');
// timing patterns alternate along row/col 6
assert.ok(m.modules[6][8] !== m.modules[6][9], 'horizontal timing alternates');
assert.ok(m.modules[8][6] !== m.modules[9][6], 'vertical timing alternates');
ok('matrix has correct size, boolean cells, finders and timing patterns');

// --- golden fingerprint (mask + dark-count + positional signature) -----------
let dark = 0, sig = 0;
for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.modules[r][c]) { dark++; sig = (sig * 31 + r * m.size + c) >>> 0; }
assert.strictEqual(m.version, 4, 'golden: version 4');
assert.strictEqual(m.mask, 2, 'golden: chosen mask 2');
assert.strictEqual(dark, 589, 'golden: dark-module count');
assert.strictEqual(sig, 156870829, 'golden: positional signature');
ok('golden fingerprint matches the jsQR-verified output');

// --- SVG output is well-formed ----------------------------------------------
const svg = QR.svg('https://example.com/watch', { ecl: 'M', scale: 4 });
assert.ok(/^<svg[^>]+>.*<\/svg>$/.test(svg), 'svg() returns a single <svg> element');
assert.ok(/<path d="M/.test(svg), 'svg carries a module path');
ok('svg() renders a self-contained scalable QR');

console.log('\n\x1b[32m' + passed + ' passing\x1b[0m\n');
