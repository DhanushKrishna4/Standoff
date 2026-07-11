/* =============================================================================
 * engine.test.js — proves the merging & tie-breaking logic.
 *
 * No framework, no dependencies. Run with:  node engine.test.js
 * Exits non-zero on the first failure so it works in CI.
 *
 * The social-choice math is tested two ways:
 *   • Unit level — feeding synthetic, hand-computed utility tables straight into
 *     the pure scoring functions, so the expected numbers are checkable by hand.
 *   • Integration — running the whole resolve() over the real catalog to prove
 *     vetoes, runtime relaxation, determinism, and (the headline feature) that
 *     fairness memory actually breaks a dead-even tie toward whoever is owed.
 * ========================================================================== */

const assert = require('assert');
const E = require('./engine.js');
const { CATALOG } = require('./catalog.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (err) {
    console.log('  \x1b[31m✗ ' + name + '\x1b[0m');
    console.error('    ' + (err && err.message ? err.message : err));
    process.exitCode = 1;
    throw err; // stop on first failure
  }
}
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

console.log('\nengine.test.js\n');

/* ---- Stage 2: group metrics are computed correctly --------------------- */
test('groupMetrics: floor, welfare and Copeland match hand calculation', () => {
  const crew = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  const feasible = [{ id: 'x' }, { id: 'y' }];
  const norm = {
    x: { A: 1, B: 1, C: 1 }, // universally loved
    y: { A: 1, B: 0, C: 0 }, // one champion, two indifferent
  };
  const m = E.groupMetrics(crew, feasible, norm);
  assert.ok(approx(m.x.floor, 1), 'x floor should be 1');
  assert.ok(approx(m.y.floor, 0), 'y floor should be 0');
  assert.ok(approx(m.y.welfare, 1 / 3), 'y welfare should be 1/3');
  // Majority (B & C) strictly prefers x to y; A ties. So x beats y.
  assert.ok(approx(m.x.copeland, 1), 'x is a Condorcet winner');
  assert.ok(approx(m.y.copeland, 0), 'y loses the pairwise');
});

/* ---- Stage 4: the composite is egalitarian, not utilitarian ------------ */
test('composite: a "nobody-miserable" option beats a higher-average polarising one', () => {
  const crew = [{ name: 'A' }, { name: 'B' }];
  const feasible = [{ id: 'balanced' }, { id: 'polar' }];
  const norm = {
    balanced: { A: 0.7, B: 0.7 }, // solid for both
    polar:    { A: 1.0, B: 0.2 }, // A adores, B tolerates — higher raw average
  };
  const m = E.groupMetrics(crew, feasible, norm);
  const fair = E.fairnessBonus(crew, feasible, norm, { debt: {} });
  const cBalanced = E.composite({ id: 'balanced' }, m, fair);
  const cPolar = E.composite({ id: 'polar' }, m, fair);
  assert.ok(
    cBalanced > cPolar,
    `balanced (${cBalanced.toFixed(3)}) should beat polar (${cPolar.toFixed(3)})`
  );
});

/* ---- within-person normalisation neutralises harsh vs generous raters -- */
test('normalisation: a harsh rater cannot dominate via scale alone', () => {
  // Same *ordering* for both people, wildly different raw generosity.
  const crew = [
    { name: 'Generous', genres: { Comedy: 'love', Drama: 'like' }, mood: { brain: 0.5, intensity: 0.5, levity: 0.5 } },
    { name: 'Harsh', genres: { Comedy: 'like', Drama: 'neutral' }, mood: { brain: 0.5, intensity: 0.5, levity: 0.5 } },
  ];
  // Self-contained candidates (not tied to catalog data) with distinct profiles.
  const feasible = [
    { id: 'c1', genres: ['Comedy'], brain: 0.40, intensity: 0.40, levity: 0.85, runtime: 102, score: 84 },
    { id: 'c2', genres: ['Drama', 'Romance'], brain: 0.65, intensity: 0.35, levity: 0.55, runtime: 135, score: 88 },
    { id: 'c3', genres: ['Comedy', 'Crime'], brain: 0.30, intensity: 0.35, levity: 0.90, runtime: 22, score: 82 },
  ];
  const { norm } = E.normaliseUtilities(crew, feasible);
  // Every person's own best option is exactly 1 and worst exactly 0 — scale removed.
  for (const p of crew) {
    const vals = feasible.map((c) => norm[c.id][p.name]);
    assert.ok(approx(Math.max(...vals), 1), p.name + ' top should normalise to 1');
    assert.ok(approx(Math.min(...vals), 0), p.name + ' bottom should normalise to 0');
  }
});

/* ---- Stage 3: fairness bonus tracks who is owed ------------------------ */
test('fairnessBonus: debt lifts options the owed person prefers', () => {
  const crew = [{ name: 'A' }, { name: 'B' }];
  const feasible = [{ id: 'x' }, { id: 'y' }];
  const norm = { x: { A: 1, B: 0 }, y: { A: 0, B: 1 } };

  const none = E.fairnessBonus(crew, feasible, norm, { debt: {} });
  assert.ok(approx(none.magnitude, 0), 'no debt → no nudge');
  assert.ok(approx(none.bonus.x, 0) && approx(none.bonus.y, 0), 'no debt → zero bonus');

  const owedA = E.fairnessBonus(crew, feasible, norm, { debt: { A: 2, B: 0 } });
  assert.ok(owedA.bonus.x > owedA.bonus.y, "A is owed → A's favourite gets the lift");
});

/* ---- commit(): debt = shortfall in *lifetime* satisfaction ---------------- */
test('commit: debt tracks cumulative satisfaction and evens out over nights', () => {
  let mem = {};
  const pick = { id: 'x', title: 'X', year: 2020 };

  // Night 1: A had a worse night (0.4) than B (0.8) → A is owed 0.2.
  mem = E.commit(mem, pick, [{ name: 'A', util: 0.4 }, { name: 'B', util: 0.8 }]);
  assert.ok(approx(mem.debt.A, 0.2), 'A should be owed 0.2 after one lopsided night');
  assert.ok(approx(mem.debt.B, 0), 'B is ahead → owed nothing');
  assert.ok(approx(mem.cumulative.A, 0.4) && approx(mem.cumulative.B, 0.8), 'cumulative tracked');
  assert.strictEqual(mem.nights, 1, 'night counted');

  // Night 2 flips it. Now lifetimes are equal (1.2 each) → nobody is owed.
  mem = E.commit(mem, pick, [{ name: 'A', util: 0.8 }, { name: 'B', util: 0.4 }]);
  assert.ok(approx(mem.debt.A, 0) && approx(mem.debt.B, 0), 'equal lifetime satisfaction → all square');

  // Night 3 pulls A ahead → B is now the one owed.
  mem = E.commit(mem, pick, [{ name: 'A', util: 0.9 }, { name: 'B', util: 0.3 }]);
  assert.ok(approx(mem.debt.B, 0.3), 'B has now fallen behind on lifetime satisfaction');
  assert.ok(approx(mem.debt.A, 0), 'A, ahead over three nights, is owed nothing');
});

/* ---- markSeen(): remembered soft exclusion -------------------------------- */
test('markSeen: adds and removes titles from the crew\'s seen list', () => {
  let mem = E.markSeen({}, 'parasite', true);
  assert.ok(mem.seen.includes('parasite'), 'marked seen');
  mem = E.markSeen(mem, 'parasite', false);
  assert.ok(!mem.seen.includes('parasite'), 'unmarked');
});

/* ---- Integration: vetoes are sacred ------------------------------------ */
test('resolve: a veto removes a whole genre from contention', () => {
  const crew = [
    { name: 'Ren', genres: { Horror: 'veto' }, mood: { brain: 0.5, intensity: 0.7, levity: 0.3 }, runtimeCap: 180 },
    { name: 'Sam', genres: { Thriller: 'love' }, mood: { brain: 0.6, intensity: 0.7, levity: 0.3 }, runtimeCap: 180 },
  ];
  const res = E.resolve(crew, CATALOG, {}, { debt: {}, history: [] });
  assert.ok(res.pick, 'should still find a pick');
  assert.ok(!res.pick.genres.includes('Horror'), 'picked title must not be Horror');
  for (const row of res.ranking) {
    assert.ok(!row.candidate.genres.includes('Horror'), 'no Horror survives to the ranking');
  }
  const horrorCut = res.filteredOut.filter((f) =>
    f.reasons.some((r) => r.type === 'veto' && r.genre === 'Horror' && r.by === 'Ren')
  );
  assert.ok(horrorCut.length >= 1, "Ren's veto should be recorded on the cut list");
});

/* ---- Integration: runtime cap filters, then relaxes if it must --------- */
test('resolve: an impossible runtime cap relaxes rather than returning nothing', () => {
  const crew = [
    { name: 'A', genres: {}, mood: { brain: 0.5, intensity: 0.5, levity: 0.5 }, runtimeCap: 20 },
    { name: 'B', genres: {}, mood: { brain: 0.5, intensity: 0.5, levity: 0.5 }, runtimeCap: 20 },
  ];
  // Self-contained menu where every title is far over the cap, so 20 min is
  // genuinely impossible and a relaxation is forced (independent of catalog data).
  const menu = [
    { id: 'long1', genres: ['Drama'], brain: 0.5, intensity: 0.5, levity: 0.5, runtime: 120, score: 85 },
    { id: 'long2', genres: ['Action'], brain: 0.5, intensity: 0.6, levity: 0.4, runtime: 140, score: 84 },
  ];
  const res = E.resolve(crew, menu, {}, { debt: {}, history: [] });
  assert.ok(res.pick, 'must return a real choice, not an empty menu');
  assert.ok(res.relaxations.length >= 1, 'a relaxation should be recorded');
  assert.strictEqual(res.relaxations[0].type, 'runtime', 'and it should be the runtime cap');
});

/* ---- Integration: determinism ------------------------------------------ */
test('resolve: identical inputs produce an identical verdict', () => {
  const crew = [
    { name: 'A', genres: { 'Sci-Fi': 'love' }, mood: { brain: 0.8, intensity: 0.6, levity: 0.3 }, runtimeCap: 180 },
    { name: 'B', genres: { Comedy: 'love' }, mood: { brain: 0.4, intensity: 0.4, levity: 0.8 }, runtimeCap: 180 },
    { name: 'C', genres: { Drama: 'like' }, mood: { brain: 0.6, intensity: 0.5, levity: 0.5 }, runtimeCap: 180 },
  ];
  const a = E.resolve(crew, CATALOG, {}, { debt: {}, history: [] });
  const b = E.resolve(crew, CATALOG, {}, { debt: {}, history: [] });
  assert.strictEqual(a.pick.id, b.pick.id, 'same pick');
  assert.deepStrictEqual(
    a.ranking.map((r) => r.candidate.id),
    b.ranking.map((r) => r.candidate.id),
    'same full ordering'
  );
});

/* ---- Integration: THE headline feature --------------------------------- */
/* A perfectly symmetric standoff between two people. With no history it is a
 * genuine coin flip — and the engine says so. Load the scale with debt toward
 * one person and the tie resolves toward the option that person prefers. This
 * is the difference between a recommender and a fair deadlock breaker.        */
test('resolve: a dead-even tie is a declared coin flip — until fairness memory decides it', () => {
  const A = { name: 'A', genres: { Action: 'love', Romance: 'dislike' }, mood: { brain: 0.5, intensity: 0.5, levity: 0.5 }, runtimeCap: 180 };
  const B = { name: 'B', genres: { Romance: 'love', Action: 'dislike' }, mood: { brain: 0.5, intensity: 0.5, levity: 0.5 }, runtimeCap: 180 };
  const crew = [A, B];

  // Two mirror-image options (self-contained, not catalog-dependent): A's kind
  // of film vs B's kind, otherwise identical.
  const menu = [
    { id: 'action-pick', genres: ['Action'], brain: 0.5, intensity: 0.7, levity: 0.4, runtime: 110, score: 85 },
    { id: 'romance-pick', genres: ['Romance'], brain: 0.5, intensity: 0.3, levity: 0.6, runtime: 110, score: 85 },
  ];

  const noHistory = E.resolve(crew, menu, {}, { debt: {}, history: [] });
  assert.ok(noHistory.tieBreak.happened, 'a symmetric standoff should register as a tie');
  assert.ok(noHistory.tieBreak.coinFlip, 'and with no history it is honestly a coin flip');

  const owedA = E.resolve(crew, menu, {}, { debt: { A: 2, B: 0 }, history: [] });
  assert.strictEqual(owedA.pick.id, 'action-pick', "A is owed → the tie breaks to A's kind of film");

  const owedB = E.resolve(crew, menu, {}, { debt: { B: 2, A: 0 }, history: [] });
  assert.strictEqual(owedB.pick.id, 'romance-pick', "B is owed → the tie breaks the other way");
});

/* ---- Integration: full explanation is populated ------------------------ */
test('resolve: produces a complete, human-readable explanation', () => {
  const crew = [
    { name: 'A', genres: { 'Sci-Fi': 'love', Horror: 'veto' }, mood: { brain: 0.8, intensity: 0.6, levity: 0.3 }, runtimeCap: 140 },
    { name: 'B', genres: { Comedy: 'love' }, mood: { brain: 0.4, intensity: 0.4, levity: 0.8 }, runtimeCap: 140 },
  ];
  const res = E.resolve(crew, CATALOG, {}, { debt: {}, history: [] });
  const x = res.explanation;
  assert.ok(x.headline.includes(res.pick.title), 'headline names the pick');
  assert.ok(typeof x.primary === 'string' && x.primary.length > 20, 'has a primary rationale');
  assert.strictEqual(x.perPerson.length, crew.length, 'a satisfaction row per person');
  assert.ok(x.confidence, 'reports a confidence band');
  assert.ok(Array.isArray(x.ruledOut), 'lists what was ruled out');
});

/* ---- Method panel: the classic methods embody different philosophies ---- */
test('methodPanel: utilitarian and egalitarian diverge; Condorcet winner is found', () => {
  const crew = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  const feasible = [{ id: 'x' }, { id: 'y' }, { id: 'z' }];
  const norm = {
    x: { A: 0.6, B: 0.6, C: 0.6 }, // balanced — best floor
    y: { A: 1.0, B: 1.0, C: 0.1 }, // high average, but strands C
    z: { A: 0.3, B: 0.3, C: 0.3 }, // mediocre all round
  };
  const m = E.groupMetrics(crew, feasible, norm);
  const panel = E.methodPanel(feasible, norm, m, ['A', 'B', 'C']);
  assert.strictEqual(panel.winners.utilitarian, 'y', 'utilitarian maximises the average → y');
  assert.strictEqual(panel.winners.egalitarian, 'x', 'egalitarian maximises the floor → x');
  assert.notStrictEqual(panel.winners.utilitarian, panel.winners.egalitarian, 'the philosophies disagree');
  // y beats both x and z in majority head-to-heads → it is the Condorcet winner.
  assert.strictEqual(panel.condorcet, 'y', 'y is the Condorcet winner');
});

/* ---- resolve() surfaces the whole method family and a consensus read-out - */
test('resolve: reports how the eleven methods voted and a consensus line', () => {
  const crew = [
    { name: 'A', genres: { Comedy: 'love', Crime: 'like' }, mood: { brain: 0.5, intensity: 0.5, levity: 0.65 }, runtimeCap: 160 },
    { name: 'B', genres: { Thriller: 'love', Crime: 'love' }, mood: { brain: 0.7, intensity: 0.65, levity: 0.4 }, runtimeCap: 160 },
    { name: 'C', genres: { Comedy: 'love', Thriller: 'like' }, mood: { brain: 0.6, intensity: 0.55, levity: 0.6 }, runtimeCap: 160 },
  ];
  const r = E.resolve(crew, CATALOG, {}, {});
  assert.strictEqual(r.methods.total, 11, 'eleven methods reported');
  assert.strictEqual(r.methods.winners.length, 11, 'a winner per method');
  assert.ok(r.methods.agreeCount >= 1 && r.methods.agreeCount <= 11, 'agreement count in range');
  assert.ok(r.methods.winners.some((w) => w.isPick), 'at least one method backs the pick');
  // every named rule of the family is present
  const keys = new Set(r.methods.winners.map((w) => w.key));
  ['utilitarian', 'egalitarian', 'nash', 'borda', 'copeland', 'kemeny', 'schulze', 'rankedPairs', 'stv', 'majority', 'approval']
    .forEach((k) => assert.ok(keys.has(k), 'family includes ' + k));
  // the Kemeny consensus order is a full permutation of the feasible menu
  assert.ok(Array.isArray(r.kemeny.order) && r.kemeny.order.length >= 2, 'kemeny order present');
  assert.ok(r.kemeny.agreement >= 0 && r.kemeny.agreement <= 1, 'kemeny agreement in [0,1]');
  assert.ok(typeof r.explanation.consensus === 'string' && r.explanation.consensus.length > 20, 'consensus prose present');
});

/* ---- "seen it" removes a title and records why -------------------------- */
test('resolve: a title marked seen is dropped and explained', () => {
  const crew = [
    { name: 'A', genres: { 'Sci-Fi': 'love' }, mood: { brain: 0.7, intensity: 0.6, levity: 0.4 }, runtimeCap: 180 },
    { name: 'B', genres: { Comedy: 'love' }, mood: { brain: 0.4, intensity: 0.4, levity: 0.8 }, runtimeCap: 180 },
  ];
  const first = E.resolve(crew, CATALOG, {}, {});
  const seenId = first.pick.id;
  const second = E.resolve(crew, CATALOG, { seen: [seenId] }, {});
  assert.notStrictEqual(second.pick.id, seenId, 'the seen title is no longer picked');
  assert.ok(!second.ranking.some((row) => row.candidate.id === seenId), 'seen title absent from the ranking');
  assert.ok(second.filteredOut.some((f) => f.reasons.some((x) => x.type === 'seen')), 'recorded as a seen cut');
  assert.ok(second.explanation.ruledOut.some((s) => /seen/.test(s)), 'explanation mentions it');
});

/* ---- seen memory persists through commit and is honoured by resolve ----- */
test('resolve + markSeen: memory-level seen list is honoured', () => {
  const crew = [
    { name: 'A', genres: { 'Sci-Fi': 'love' }, mood: { brain: 0.7, intensity: 0.6, levity: 0.4 }, runtimeCap: 180 },
    { name: 'B', genres: { Comedy: 'love' }, mood: { brain: 0.4, intensity: 0.4, levity: 0.8 }, runtimeCap: 180 },
  ];
  let mem = {};
  const first = E.resolve(crew, CATALOG, {}, mem);
  mem = E.markSeen(mem, first.pick.id, true);
  const second = E.resolve(crew, CATALOG, {}, mem); // no explicit options.seen — read from memory
  assert.notStrictEqual(second.pick.id, first.pick.id, 'memory seen list steers the next pick');
});

/* ---- pickWinner agrees with resolve ------------------------------------- */
test('pickWinner: matches resolve\'s pick exactly', () => {
  const crew = [
    { name: 'A', genres: { 'Sci-Fi': 'love', Action: 'like' }, mood: { brain: 0.6, intensity: 0.7, levity: 0.4 }, runtimeCap: 170 },
    { name: 'B', genres: { Comedy: 'love', Crime: 'like' }, mood: { brain: 0.5, intensity: 0.5, levity: 0.7 }, runtimeCap: 170 },
    { name: 'C', genres: { Drama: 'love' }, mood: { brain: 0.6, intensity: 0.5, levity: 0.5 }, runtimeCap: 170 },
  ];
  const r = E.resolve(crew, CATALOG, {}, {});
  assert.strictEqual(E.pickWinner(crew, CATALOG, {}, {}), r.pick.id, 'lean path equals full resolve');
});

/* ---- Condorcet cycle detection ------------------------------------------ */
test('findCycle: detects a rock-paper-scissors majority cycle', () => {
  // Classic 3-voter Condorcet cycle over x, y, z.
  const feasible = [{ id: 'x', title: 'X' }, { id: 'y', title: 'Y' }, { id: 'z', title: 'Z' }];
  const norm = {
    x: { A: 1.0, B: 0.5, C: 0.0 },
    y: { A: 0.5, B: 0.0, C: 1.0 },
    z: { A: 0.0, B: 1.0, C: 0.5 },
  }; // A: x>y>z, B: z>x>y, C: y>z>x  → x beats y beats z beats x
  const ranking = feasible.map((c) => ({ candidate: c }));
  const cycle = E.findCycle(feasible, norm, ['A', 'B', 'C'], ranking);
  assert.ok(cycle && cycle.length === 3, 'a 3-cycle is found');
  // it should be a real cycle under majorityBeats
  const [a, b, c] = cycle.map((t) => feasible.find((f) => f.title === t).id);
  assert.ok(E.majorityBeats(norm, ['A', 'B', 'C'], a, b) > 0, 'first beats second');
  assert.ok(E.majorityBeats(norm, ['A', 'B', 'C'], c, a) > 0, 'third beats first (closing the loop)');
});

/* ---- robustness analysis ------------------------------------------------ */
test('analyzeVerdict: reports robustness with a pivotal counterfactual when fragile', () => {
  const crew = [
    { name: 'A', genres: { 'Sci-Fi': 'love', Action: 'love' }, mood: { brain: 0.6, intensity: 0.7, levity: 0.4 }, runtimeCap: 170 },
    { name: 'B', genres: { Comedy: 'love', Crime: 'like' }, mood: { brain: 0.5, intensity: 0.5, levity: 0.7 }, runtimeCap: 170 },
    { name: 'C', genres: { Drama: 'love', Thriller: 'like' }, mood: { brain: 0.62, intensity: 0.6, levity: 0.45 }, runtimeCap: 170 },
  ];
  const honest = E.resolve(crew, CATALOG, {}, {});
  const a = E.analyzeVerdict(crew, CATALOG, {}, honest);
  assert.ok(a && a.robustness, 'robustness reported');
  assert.ok(a.robustness.tested > 20, 'many perturbations were actually tested');
  assert.ok(a.robustness.score >= 0 && a.robustness.score <= 1, 'score in [0,1]');
  assert.ok(a.robustness.robust === (a.robustness.flips === 0), 'robust flag consistent with flips');
  // every pivotal counterfactual really does name a different winner
  a.robustness.pivotal.forEach((pv) => assert.notStrictEqual(pv.newWinnerId, honest.pick.id, 'pivotal flips the pick'));
});

/* ---- strategyproofness analysis ----------------------------------------- */
test('analyzeVerdict: strategy check is self-consistent (a flagged manipulator truly gains)', () => {
  const crew = [
    { name: 'A', genres: { 'Sci-Fi': 'love', Thriller: 'like' }, mood: { brain: 0.7, intensity: 0.8, levity: 0.2 }, runtimeCap: 170 },
    { name: 'B', genres: { Romance: 'love', Comedy: 'love' }, mood: { brain: 0.4, intensity: 0.3, levity: 0.85 }, runtimeCap: 170 },
  ];
  const honest = E.resolve(crew, CATALOG, {}, {});
  const a = E.analyzeVerdict(crew, CATALOG, {}, honest);
  assert.ok(a && a.strategy, 'strategy reported');
  assert.strictEqual(a.strategy.strategyproof, a.strategy.manipulators.length === 0, 'flag consistent');
  // build each person's true utility to independently verify any flagged gain
  const trueU = {};
  honest.ranking.forEach((r) => r.perPerson.forEach((pp) => { (trueU[pp.name] = trueU[pp.name] || {})[r.candidate.id] = pp.util; }));
  a.strategy.manipulators.forEach((m) => {
    assert.ok(trueU[m.who][m.altId] > trueU[m.who][honest.pick.id], `${m.who} genuinely prefers the manipulated outcome`);
  });
});

/* =============================================================================
 * Batch 2 — deepened engine: the method family, conviction, novelty, group
 * constraints, the feedback loop, and formal strategyproofness.
 * ========================================================================== */

/* ---- item 7: Kemeny–Young consensus ranking ----------------------------- */
test('kemenyYoung: a unanimous profile yields the unanimous order with zero dissent', () => {
  const ids = ['x', 'y', 'z'];
  const names = ['v1', 'v2', 'v3'];
  const norm = { x: { v1: 1, v2: 1, v3: 1 }, y: { v1: 0.5, v2: 0.5, v3: 0.5 }, z: { v1: 0, v2: 0, v3: 0 } };
  const { P } = E.pairwiseMatrix(ids, norm, names, [1, 1, 1]);
  const k = E.kemenyYoung(ids, P);
  assert.deepStrictEqual(k.order, ['x', 'y', 'z'], 'consensus order is the unanimous order');
  assert.strictEqual(k.disagreements, 0, 'nobody is overruled');
  assert.strictEqual(k.inversions, 0, 'no pair ranked against its majority');
  assert.ok(approx(k.agreement, 1), 'agreement is total');
});

test('kemenyYoung: a Condorcet cycle forces exactly one overruled pair', () => {
  // x>y, y>z, z>x each by 2:1 — the rock-paper-scissors profile.
  const ids = ['x', 'y', 'z'];
  const names = ['A', 'B', 'C'];
  const norm = {
    x: { A: 1.0, B: 0.5, C: 0.0 },
    y: { A: 0.5, B: 0.0, C: 1.0 },
    z: { A: 0.0, B: 1.0, C: 0.5 },
  };
  const { P } = E.pairwiseMatrix(ids, norm, names, [1, 1, 1]);
  const k = E.kemenyYoung(ids, P);
  assert.strictEqual(k.order.length, 3, 'a full order is produced');
  assert.strictEqual(k.disagreements, 4, 'the least-dissent order overrules 4 voter-preferences');
  assert.strictEqual(k.inversions, 1, 'exactly one pair is ranked against its majority (the cycle)');
  assert.ok(k.agreement < 1, 'a cycle cannot be fully honoured');
});

/* ---- item 8: the whole method family, agreeing and disagreeing ---------- */
test('method family: Condorcet rules agree on the beats-all option; IRV can differ', () => {
  // Classic divergence: 5 voters, IRV drops the Condorcet winner.
  //   v1,v2: a>b>c   v3,v4: c>b>a   v5: b>c>a
  const ids = ['a', 'b', 'c'];
  const names = ['v1', 'v2', 'v3', 'v4', 'v5'];
  const ws = [1, 1, 1, 1, 1];
  const norm = {
    a: { v1: 1.0, v2: 1.0, v3: 0.0, v4: 0.0, v5: 0.0 },
    b: { v1: 0.5, v2: 0.5, v3: 0.5, v4: 0.5, v5: 1.0 },
    c: { v1: 0.0, v2: 0.0, v3: 1.0, v4: 1.0, v5: 0.5 },
  };
  const { P, margin } = E.pairwiseMatrix(ids, norm, names, ws);
  // b beats a (3:2) and c (3:2) → Condorcet winner.
  assert.strictEqual(E.schulzeOrder(ids, P).winner, 'b', 'Schulze picks the Condorcet winner');
  assert.strictEqual(E.rankedPairsOrder(ids, margin).winner, 'b', 'Ranked Pairs picks it too');
  assert.strictEqual(E.approvalWinner(ids, norm, names, ws).winner, 'b', 'Approval (above-average) also lands on b');
  // IRV eliminates b first (fewest first-choices) and elects c — the famous failure.
  assert.strictEqual(E.stvWinner(ids, norm, names, ws).winner, 'c', 'IRV drops the Condorcet winner and elects c');
  // The point of the panel: the family genuinely splits here.
  const winners = new Set(['b', 'c']);
  assert.ok(winners.size >= 2, 'the method family disagrees — that disagreement is the story');
});

test('resolve: the eleven-method family and Kemeny order are exposed together', () => {
  const crew = [
    { name: 'A', genres: { Action: 'love', 'Sci-Fi': 'like' }, mood: { brain: 0.6, intensity: 0.7, levity: 0.4 }, runtimeCap: 180 },
    { name: 'B', genres: { Drama: 'love', Crime: 'like' }, mood: { brain: 0.65, intensity: 0.5, levity: 0.35 }, runtimeCap: 180 },
    { name: 'C', genres: { Comedy: 'love' }, mood: { brain: 0.4, intensity: 0.4, levity: 0.8 }, runtimeCap: 180 },
  ];
  const r = E.resolve(crew, CATALOG, {}, {});
  assert.strictEqual(r.methods.winners.length, 11, 'eleven rules reported');
  assert.ok(r.methods.familiesTotal >= 3, 'multiple philosophical families represented');
  assert.ok(new Set(r.kemeny.orderIds).size === r.kemeny.orderIds.length, 'Kemeny order has no repeats');
  assert.ok(r.kemeny.orderIds.includes(r.pick.id) || r.kemeny.orderIds.length < r.ranking.length, 'kemeny ranks the finalists');
});

/* ---- item 9: conviction weighting (bounded, mean-1, un-gameable) -------- */
test('convictionWeights: bounded, average exactly 1, and inflation-proof', () => {
  const w = E.convictionWeights([{ name: 'A', conviction: 'care' }, { name: 'B', conviction: 'easy' }, { name: 'C' }]);
  const vals = ['A', 'B', 'C'].map((n) => w[n]);
  assert.ok(approx((vals[0] + vals[1] + vals[2]) / 3, 1), 'weights average to 1');
  assert.ok(w.A > w.C && w.C > w.B, 'care > normal > easy');
  vals.forEach((v) => assert.ok(v >= 0.5 && v <= 1.6, 'each weight is hard-bounded'));
  // The anti-manipulation core: if EVERYONE claims to care, nobody gains an edge.
  const allCare = E.convictionWeights([{ name: 'A', conviction: 'care' }, { name: 'B', conviction: 'care' }]);
  assert.ok(approx(allCare.A, 1) && approx(allCare.B, 1), 'universal max-conviction cancels out');
});

test('resolve: conviction tips a dead-even standoff toward whoever cares more', () => {
  const mk = (convA, convB) => ([
    { name: 'A', genres: { Action: 'love', Romance: 'dislike' }, mood: { brain: 0.5, intensity: 0.5, levity: 0.5 }, runtimeCap: 180, conviction: convA },
    { name: 'B', genres: { Romance: 'love', Action: 'dislike' }, mood: { brain: 0.5, intensity: 0.5, levity: 0.5 }, runtimeCap: 180, conviction: convB },
  ]);
  const menu = [
    { id: 'action-pick', genres: ['Action'], brain: 0.5, intensity: 0.7, levity: 0.4, runtime: 110, score: 85 },
    { id: 'romance-pick', genres: ['Romance'], brain: 0.5, intensity: 0.3, levity: 0.6, runtime: 110, score: 85 },
  ];
  assert.strictEqual(E.resolve(mk('care', 'easy'), menu, {}, {}).pick.id, 'action-pick', 'A cares more → A’s film');
  assert.strictEqual(E.resolve(mk('easy', 'care'), menu, {}, {}).pick.id, 'romance-pick', 'B cares more → B’s film');
  // …but if both max out, it collapses back to the honest coin-flip.
  assert.ok(E.resolve(mk('care', 'care'), menu, {}, {}).tieBreak.coinFlip, 'equal conviction ⇒ still a coin flip');
});

/* ---- item 10: novelty axis (surprise ↔ comfort) ------------------------- */
test('rawUtility: the novelty axis separates a surprise-seeker from a comfort-seeker', () => {
  const novel = { id: 'novel', genres: ['Drama'], brain: 0.5, intensity: 0.5, levity: 0.5, novelty: 0.9, score: 80 };
  const comfort = { id: 'comfort', genres: ['Drama'], brain: 0.5, intensity: 0.5, levity: 0.5, novelty: 0.1, score: 80 };
  const surpriseSeeker = { name: 'S', genres: {}, mood: { novelty: 0.9 } };
  const comfortSeeker = { name: 'C', genres: {}, mood: { novelty: 0.1 } };
  assert.ok(E.rawUtility(surpriseSeeker, novel) > E.rawUtility(surpriseSeeker, comfort), 'surprise-seeker prefers the novel option');
  assert.ok(E.rawUtility(comfortSeeker, comfort) > E.rawUtility(comfortSeeker, novel), 'comfort-seeker prefers the familiar option');
});

/* ---- item 11: group-composition constraints ----------------------------- */
test('applyConstraints: rating cap and content-warnings are sacred; runtime relaxes', () => {
  const crew = [{ name: 'A', genres: {} }, { name: 'B', genres: {} }];
  const catalog = [
    { id: 'kidfilm', genres: ['Animation'], runtime: 95, ratingLevel: 1, warnings: [] },
    { id: 'harsh', genres: ['Horror'], runtime: 100, ratingLevel: 4, warnings: ['gore', 'violence'] },
    { id: 'longpg', genres: ['Adventure'], runtime: 175, ratingLevel: 1, warnings: [] },
  ];
  // Kids present (cap PG=1) + no gore.
  const r = E.applyConstraints(crew, catalog, { maxRatingLevel: 1, blockedWarnings: ['gore'] });
  const ids = r.feasible.map((c) => c.id);
  assert.ok(ids.includes('kidfilm'), 'a kid-safe title survives');
  assert.ok(!ids.includes('harsh'), 'the R-rated / gory title is cut');
  const harshCut = r.filteredOut.find((f) => f.cand.id === 'harsh');
  assert.ok(harshCut.reasons.some((x) => x.type === 'rating'), 'cut records the rating reason');
  assert.ok(harshCut.reasons.some((x) => x.type === 'warning' && /gore/i.test(x.warning)), 'and the warning reason');
});

test('resolve: rating/warning constraints are never relaxed away, even if the menu empties', () => {
  const crew = [{ name: 'A', genres: {} }, { name: 'B', genres: {} }];
  const catalog = [
    { id: 'r1', genres: ['Horror'], brain: 0.5, intensity: 0.9, levity: 0.2, runtime: 100, ratingLevel: 4, warnings: ['gore'] },
    { id: 'r2', genres: ['Thriller'], brain: 0.6, intensity: 0.85, levity: 0.25, runtime: 110, ratingLevel: 4, warnings: ['violence'] },
  ];
  const r = E.resolve(crew, catalog, { constraints: { maxRatingLevel: 1 } }, {});
  assert.ok(r.empty, 'no kid-safe option exists → we honestly return nothing rather than relax a safety rail');
});

test('resolve: a school-night runtime cap binds the whole group', () => {
  const crew = [{ name: 'A', genres: {}, runtimeCap: 999 }, { name: 'B', genres: {}, runtimeCap: 999 }];
  const catalog = [
    { id: 'short', genres: ['Comedy'], brain: 0.3, intensity: 0.3, levity: 0.9, runtime: 95, score: 80 },
    { id: 'epic', genres: ['Adventure'], brain: 0.5, intensity: 0.6, levity: 0.5, runtime: 200, score: 88 },
  ];
  const r = E.resolve(crew, catalog, { constraints: { groupRuntimeCap: 120, groupRuntimeLabel: 'school night' } }, {});
  assert.strictEqual(r.pick.id, 'short', 'the over-cap epic is filtered by the group runtime cap');
});

/* ---- item 12: post-watch feedback loop calibrates the model ------------- */
test('recordFeedback: enjoying less than predicted cools that genre for that person', () => {
  const pick = { id: 'x', title: 'X', genres: ['Crime'] };
  let mem = { history: [{ pickId: 'x', title: 'X', satisfaction: [{ name: 'A', util: 80 }] }] };
  mem = E.recordFeedback(mem, pick, [{ name: 'A', enjoyed: 0.3 }]); // predicted .8, actual .3 → negative residual
  assert.ok(mem.calibration.A.Crime < 0, 'Crime bias turns negative for A');
  const person = { name: 'A', genres: { Crime: 'like' }, mood: {} };
  const cand = { id: 'c', genres: ['Crime'], brain: 0.5, intensity: 0.5, levity: 0.5, score: 80 };
  assert.ok(E.rawUtility(person, cand, mem.calibration.A) < E.rawUtility(person, cand, null), 'calibration lowers A’s utility for Crime');
  // And it saturates rather than running away.
  for (let i = 0; i < 20; i++) mem = E.recordFeedback(mem, pick, [{ name: 'A', enjoyed: 0, predicted: 1 }]);
  assert.ok(mem.calibration.A.Crime >= -E.WEIGHTS.utility.calibration && mem.calibration.A.Crime >= -1, 'the learned bias is bounded');
  assert.ok(mem.calibration.A.Crime <= -0.4, 'sustained disappointment saturates toward the cap');
});

test('recordFeedback: enjoying MORE than predicted warms the genre back up', () => {
  const pick = { id: 'y', title: 'Y', genres: ['Documentary'] };
  let mem = {};
  mem = E.recordFeedback(mem, pick, [{ name: 'B', enjoyed: 0.95, predicted: 0.4 }]);
  assert.ok(mem.calibration.B.Documentary > 0, 'a happy surprise warms the genre');
  assert.ok(Array.isArray(mem.feedbackLog) && mem.feedbackLog.length === 1, 'feedback is logged');
});

/* ---- item 13: formal strategyproofness metrics -------------------------- */
test('analyzeVerdict: strategyproofness is a bounded exhaustive search with real metrics', () => {
  const crew = [
    { name: 'A', genres: { 'Sci-Fi': 'love', Thriller: 'like' }, mood: { brain: 0.7, intensity: 0.8, levity: 0.2 }, runtimeCap: 170 },
    { name: 'B', genres: { Romance: 'love', Comedy: 'love' }, mood: { brain: 0.4, intensity: 0.3, levity: 0.85 }, runtimeCap: 170 },
    { name: 'C', genres: { Drama: 'love' }, mood: { brain: 0.6, intensity: 0.5, levity: 0.45 }, runtimeCap: 170 },
  ];
  const honest = E.resolve(crew, CATALOG, {}, {});
  const s = E.analyzeVerdict(crew, CATALOG, {}, honest).strategy;
  assert.ok(s.spaceSearched > crew.length, 'a real report space was enumerated');
  assert.strictEqual(typeof s.exhaustive, 'boolean', 'reports whether the search was exhaustive');
  assert.ok(s.manipulableShare >= 0 && s.manipulableShare <= 1, 'manipulable share is a fraction');
  assert.ok(approx(s.manipulableShare, s.manipulators.length / crew.length, 1e-3), 'share matches the manipulator count');
  assert.ok(s.maxGain >= 0, 'max gain is non-negative');
  assert.strictEqual(s.strategyproof, s.manipulators.length === 0, 'flag is consistent');
  // Any flagged manipulator's alternative is genuinely better for them (true utility).
  const trueU = {};
  honest.ranking.forEach((r) => r.perPerson.forEach((pp) => { (trueU[pp.name] = trueU[pp.name] || {})[r.candidate.id] = pp.util; }));
  s.manipulators.forEach((m) => assert.ok(trueU[m.who][m.altId] > trueU[m.who][honest.pick.id], `${m.who} truly gains`));
});

/* ---- item 14: extra learned mood axes fold in when present -------------- */
test('rawUtility: extra axes (pace/darkness/dialogue) only bind when both sides express them', () => {
  const base = { name: 'P', genres: {}, mood: { brain: 0.5, intensity: 0.5, levity: 0.5 } };
  const withAxes = { name: 'P', genres: {}, mood: { brain: 0.5, intensity: 0.5, levity: 0.5, pace: 0.9, darkness: 0.1 } };
  const fast = { id: 'f', genres: ['Action'], brain: 0.5, intensity: 0.5, levity: 0.5, pace: 0.9, darkness: 0.1, score: 80 };
  const slow = { id: 's', genres: ['Action'], brain: 0.5, intensity: 0.5, levity: 0.5, pace: 0.1, darkness: 0.9, score: 80 };
  // With no extra-axis preference, the two candidates are indistinguishable on mood.
  assert.ok(approx(E.rawUtility(base, fast), E.rawUtility(base, slow)), 'axes a person doesn’t set are ignored');
  // Expressing a fast/bright appetite makes the matching candidate score higher.
  assert.ok(E.rawUtility(withAxes, fast) > E.rawUtility(withAxes, slow), 'expressed pace/darkness discriminate');
});

console.log('\n\x1b[32m' + passed + ' passing\x1b[0m\n');
