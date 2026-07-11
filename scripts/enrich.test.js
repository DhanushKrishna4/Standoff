/* =============================================================================
 * scripts/enrich.test.js — proves the catalog-enrichment derivations (enrich.mjs):
 * the learned tone axes, novelty, rating estimate and content warnings. Fixtures
 * only, no network.
 *
 *   node scripts/enrich.test.js
 * ========================================================================== */
import assert from 'node:assert/strict';
import { enrichCatalog, rawTone, estimateRating, estimateWarnings, MOOD_AXES } from './enrich.mjs';

let passed = 0;
const ok = (name) => { passed++; console.log('  \x1b[32m✓\x1b[0m ' + name); };
const inRange = (x) => x >= 0 && x <= 1;

// A small synthetic catalog spanning the tonal space.
const CATALOG = [
  { id: 'horror',  title: 'Dread',      genres: ['Horror'],          runtime: 100, brain: 0.5, intensity: 0.9, levity: 0.15, score: 78, year: 2019 },
  { id: 'talky',   title: 'The Table',  genres: ['Drama'],           runtime: 120, brain: 0.85, intensity: 0.3, levity: 0.35, score: 82, year: 2005 },
  { id: 'action',  title: 'Boom',       genres: ['Action'],          runtime: 110, brain: 0.35, intensity: 0.85, levity: 0.5, score: 74, year: 2022 },
  { id: 'comedy',  title: 'Ha',         genres: ['Comedy'],          runtime: 96,  brain: 0.3, intensity: 0.3, levity: 0.9, score: 71, year: 2018 },
  { id: 'classic', title: 'The Canon',  genres: ['Drama', 'Crime'],  runtime: 150, brain: 0.75, intensity: 0.6, levity: 0.3, score: 95, year: 1975 },
  { id: 'obscure', title: 'Oddity',     genres: ['Fantasy'],         runtime: 88,  brain: 0.6, intensity: 0.45, levity: 0.5, score: 62, year: 2021 },
];

// --- axes exist, are in range, and are standardised to the catalog -----------
const enriched = enrichCatalog(CATALOG, 2026);
for (const e of enriched) {
  for (const ax of ['pace', 'darkness', 'dialogue', 'novelty']) {
    assert.ok(inRange(e[ax]), `${ax} in 0..1 for ${e.id}`);
  }
  assert.ok(Number.isInteger(e.ratingLevel) && e.ratingLevel >= 0 && e.ratingLevel <= 4, 'ratingLevel is 0..4');
  assert.ok(typeof e.certification === 'string', 'certification labelled');
  assert.ok(Array.isArray(e.warnings), 'warnings is an array');
}
ok('every enriched title carries in-range axes, a rating and warnings');

assert.strictEqual(MOOD_AXES.length, 7, 'seven user-facing axes are published');
assert.deepEqual(MOOD_AXES.map((a) => a.key), ['brain', 'intensity', 'levity', 'pace', 'darkness', 'dialogue', 'novelty'], 'axis order');
ok('MOOD_AXES publishes the full deepened axis set');

// --- the axes reflect real tonal character -----------------------------------
const byId = Object.fromEntries(enriched.map((e) => [e.id, e]));
assert.ok(byId.action.pace > byId.talky.pace, 'an action film is faster-paced than a talky drama');
assert.ok(byId.talky.dialogue > byId.action.dialogue, 'a cerebral drama is more dialogue-driven than an action film');
assert.ok(byId.horror.darkness > byId.comedy.darkness, 'horror is darker than comedy');
ok('learned axes reflect tonal character (pace, dialogue, darkness)');

// --- novelty: the acclaimed old classic is comfort; the obscure title is novel
assert.ok(byId.classic.novelty < byId.obscure.novelty, 'a canonical classic reads as comfort, an obscure title as novel');
ok('novelty separates canonical comfort from off-canon surprise');

// --- rating estimate & warnings ----------------------------------------------
assert.ok(byId.horror.ratingLevel >= 3, 'an intense horror lands at R or above');
assert.ok(byId.comedy.ratingLevel <= 2, 'a gentle comedy stays PG/PG-13');
assert.ok(byId.horror.warnings.includes('scary') && byId.horror.warnings.includes('violence'), 'horror is tagged scary + violent');
assert.strictEqual(byId.comedy.warnings.length, 0, 'a gentle comedy carries no warnings');
ok('rating + warning estimates track genre and tone');

// --- purity: enrichCatalog does not mutate its input -------------------------
assert.strictEqual(CATALOG[0].pace, undefined, 'input catalog is left untouched');
ok('enrichCatalog is pure (no mutation of the source)');

// --- rawTone / estimateRating are usable standalone --------------------------
const t = rawTone({ genres: ['Action'], intensity: 0.9, levity: 0.5, brain: 0.35, runtime: 100 });
assert.ok(typeof t.pace === 'number' && typeof t.darkness === 'number' && typeof t.dialogue === 'number', 'rawTone returns three signals');
const r = estimateRating({ genres: ['Horror'], intensity: 0.9, levity: 0.15, darkness: 0.85 });
assert.ok(r.ratingLevel >= 3, 'estimateRating flags a hard horror');
assert.ok(estimateWarnings({ genres: ['Comedy'], intensity: 0.3, darkness: 0.2 }).length === 0, 'estimateWarnings clean for gentle comedy');
ok('the per-title helpers work standalone');

console.log('\n\x1b[32m' + passed + ' passing\x1b[0m\n');
