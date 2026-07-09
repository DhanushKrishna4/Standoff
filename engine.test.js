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

/* ---- resolve() surfaces a method panel and a consensus read-out --------- */
test('resolve: reports how the five methods voted and a consensus line', () => {
  const crew = [
    { name: 'A', genres: { Comedy: 'love', Crime: 'like' }, mood: { brain: 0.5, intensity: 0.5, levity: 0.65 }, runtimeCap: 160 },
    { name: 'B', genres: { Thriller: 'love', Crime: 'love' }, mood: { brain: 0.7, intensity: 0.65, levity: 0.4 }, runtimeCap: 160 },
    { name: 'C', genres: { Comedy: 'love', Thriller: 'like' }, mood: { brain: 0.6, intensity: 0.55, levity: 0.6 }, runtimeCap: 160 },
  ];
  const r = E.resolve(crew, CATALOG, {}, {});
  assert.strictEqual(r.methods.total, 5, 'five methods reported');
  assert.strictEqual(r.methods.winners.length, 5, 'a winner per method');
  assert.ok(r.methods.agreeCount >= 1 && r.methods.agreeCount <= 5, 'agreement count in range');
  assert.ok(r.methods.winners.some((w) => w.isPick), 'at least one method backs the pick');
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

console.log('\n\x1b[32m' + passed + ' passing\x1b[0m\n');
