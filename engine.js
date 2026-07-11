/* =============================================================================
 * engine.js — the preference-merging & tie-breaking engine.
 *
 * This is the actual hard, interesting part. Picking a movie for one person is
 * a recommender. Picking one for a *group* is a social-choice problem: you have
 * several people with genuinely different tastes and you must produce a single
 * outcome that is (a) legitimate, (b) fair, and (c) explainable — ideally fair
 * not just tonight but across many nights with the same crew.
 *
 * Naïve approaches and why they fail:
 *   • Average the star ratings        → tyranny of the lukewarm; a film everyone
 *                                        finds "fine" beats one three people love
 *                                        and one mildly dislikes, and it lets an
 *                                        extremist drag the group by rating 0/10.
 *   • Highest total / most upvotes     → ignores intensity and leaves the
 *                                        minority reliably miserable.
 *   • Just let the loudest person pick → not a system, that's the status quo.
 *
 * What this engine does instead, in five stages:
 *
 *   Stage 0  Feasibility.   Hard constraints (vetoes, runtime caps) remove
 *                           options entirely. Vetoes are sacred; runtime caps
 *                           relax only if the menu would otherwise be empty.
 *   Stage 1  Utility.       Each person gets a taste-based utility for every
 *                           surviving option, then it is normalised *within that
 *                           person* so we can compare across people fairly
 *                           (nobody wins by rating on a harsher scale).
 *   Stage 2  Group metrics. For each option we compute several well-understood
 *                           social-choice measures: the egalitarian floor
 *                           (Rawls), mean welfare (utilitarian), the Nash
 *                           bargaining product, Copeland pairwise wins
 *                           (Condorcet), and a disagreement penalty.
 *   Stage 3  Fairness memory. Across sessions we track "compromise debt": who
 *                           has been swallowing picks they didn't love. Owed
 *                           people get a small, saturating thumb on the scale —
 *                           enough to break near-ties, never enough to override
 *                           taste. THIS is what turns a recommender into a fair
 *                           deadlock breaker over time.
 *   Stage 4  Composite + tie-break ladder. Metrics combine into one score.
 *                           Genuine near-ties are resolved by a transparent,
 *                           ordered ladder, and if it comes down to a coin flip
 *                           we say so — honesty over false precision.
 *   Stage 5  Explanation.   Everything above is turned into plain language: why
 *                           this, who compromised, what came second and exactly
 *                           why it lost, and what got ruled out.
 *
 * The engine is a pure function of (crew, catalog, options, memory). No I/O, no
 * globals, no randomness except a seeded PRNG for the final coin flip. That
 * makes it testable (see engine.test.js) and makes every verdict reproducible.
 * ========================================================================== */

(function (root) {
  'use strict';

  // ---- tunable weights -----------------------------------------------------
  // Kept in one place and documented so the value judgements are legible.
  const WEIGHTS = {
    // How a single person's raw taste utility is composed, before normalisation.
    // Ordering (not scale) is what survives normalisation, so these ratios matter.
    utility: { genre: 1.2, mood: 1.0, quality: 0.4, calibration: 0.6 },

    // Conviction weighting (item 9). Tonight a person may say how much they care.
    // These are BOUNDED multipliers on their influence in the *aggregate* measures
    // (welfare, head-to-heads, positional, bargaining) — never on the safety floor,
    // so caring more can tilt a close call but can never strand someone who cares
    // less. Weights are renormalised to mean 1 across the crew (see convictionWeights)
    // so absolute inflation is neutralised: only *relative* conviction moves anything,
    // which is what keeps the lever bounded and the manipulability finite (item 13).
    conviction: { easy: 0.6, normal: 1.0, care: 1.5 },

    // How the group metrics combine into one composite score.
    // Floor (nobody miserable) is weighted highest on purpose — for a shared
    // couch, avoiding a bad night matters more than maximising the average.
    composite: {
      floor: 0.34,        // Rawlsian: protect the least-happy person
      welfare: 0.24,      // utilitarian: overall enjoyment
      nash: 0.13,         // bargaining balance (product of utilities)
      copeland: 0.13,     // Condorcet legitimacy (beats other options head-to-head)
      fairness: 0.30,     // compromise-debt thumb on the scale. Looks large, but
                          // it is GATED BY SAFETY (see composite()) — it only acts
                          // on options that keep everyone about as happy as the
                          // best-possible floor, so it decides between good options
                          // yet can never force a bad night onto someone to repay a debt.
      disagreement: 0.10, // subtracted: penalise polarising options
    },
    safetyBand: 0.18,     // how far below the best achievable floor still counts as
                          // "nobody miserable" for the purpose of applying fairness.

    // Stance → numeric taste value. `veto` is handled as a hard filter, not here.
    stance: { love: 2, like: 1, neutral: 0, dislike: -1.5 },

    epsilon: 0.025, // composite gap below which we treat options as a near-tie
    nashFloor: 0.05, // added inside the Nash product so a single 0 doesn't nuke it
  };

  // ---- small numeric helpers ----------------------------------------------
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const stdev = (a) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(mean(a.map((x) => (x - m) * (x - m))));
  };

  // Deterministic string-seeded PRNG (mulberry32). Used ONLY for the final,
  // last-resort coin flip, so identical inputs always yield identical verdicts.
  function makeRng(seedStr) {
    let h = 1779033703 ^ String(seedStr).length;
    for (let i = 0; i < String(seedStr).length; i++) {
      h = Math.imul(h ^ String(seedStr).charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const stanceVal = (s) => (s === 'veto' ? -Infinity : (WEIGHTS.stance[s] ?? 0));

  // Mood axes a person can express and a candidate can carry. brain/intensity/
  // levity are the originals; pace/darkness/dialogue (item 14) are learned from
  // the catalog by the enrich step; novelty (item 10) is the surprise↔comfort
  // dimension (cand.novelty: 1 = obscure/surprising, 0 = canonical comfort). Every
  // axis is OPTIONAL on both sides: a person only constrains the axes they set and
  // a candidate only contributes axes it carries, so an axis missing on either side
  // simply doesn't enter the distance. This is what lets the model grow new axes
  // without disturbing older data or tests.
  const MOOD_AXES = ['brain', 'intensity', 'levity', 'pace', 'darkness', 'dialogue', 'novelty'];

  // Conviction → a bounded, mean-1 weight per person (item 9). The multiplier is
  // hard-clamped here regardless of the configured table, then renormalised so the
  // crew's weights average exactly 1 — inflating your own number lifts everyone's
  // divisor too, so only *relative* conviction has any effect, and its reach is
  // bounded. The strategyproofness search (item 13) enumerates conviction values,
  // so this claim is checked, not asserted.
  function convictionWeights(crew) {
    const raw = crew.map((p) => {
      const m = (p && p.conviction && WEIGHTS.conviction[p.conviction]) || 1;
      return Math.max(0.5, Math.min(1.6, m));
    });
    const avg = mean(raw) || 1;
    const w = {};
    crew.forEach((p, i) => { w[p.name] = raw[i] / avg; });
    return w;
  }
  const weightsFor = (crew, weights) => weights || convictionWeights(crew);

  // Weighted moments — used everywhere conviction should tilt an aggregate.
  const wmean = (vals, ws) => {
    let s = 0, sw = 0;
    for (let i = 0; i < vals.length; i++) { s += ws[i] * vals[i]; sw += ws[i]; }
    return sw ? s / sw : 0;
  };
  const wstdev = (vals, ws) => {
    if (vals.length < 2) return 0;
    const m = wmean(vals, ws);
    return Math.sqrt(Math.max(0, wmean(vals.map((x) => (x - m) * (x - m)), ws)));
  };

  // =========================================================================
  // Stage 1 — per-person raw utility for one candidate.
  // =========================================================================
  // Four ingredients:
  //   genre  — the strongest signal. We reward hitting something you love
  //            (max stance) but also reward broad fit (mean stance), so a film
  //            that is "one genre you love + two you dislike" doesn't score the
  //            same as one that's "loved across the board".
  //   mood   — closeness between tonight's requested mood and the film's tone
  //            across every axis both sides express. 1 = perfect match, 0 = opposite.
  //   quality— a gentle nudge toward well-made things; deliberately low weight.
  //   calib  — a learned per-genre correction from post-watch feedback (item 12);
  //            zero until a crew has actually rated some locked-in nights.
  function rawUtility(person, cand, calibration) {
    const stances = cand.genres.map((g) => stanceVal(person.genres?.[g] ?? 'neutral'));
    // (veto is filtered out before we ever get here, so no -Infinity remains)
    const genreScore = stances.length
      ? 0.6 * Math.max(...stances) + 0.4 * mean(stances)
      : 0;

    const mood = person.mood || {};
    const diffs = [];
    for (const ax of MOOD_AXES) {
      if (typeof mood[ax] === 'number' && typeof cand[ax] === 'number') {
        diffs.push(Math.abs(mood[ax] - cand[ax]));
      }
    }
    const moodScore = diffs.length ? 1 - mean(diffs) : 0.5;

    const qualityScore = (cand.score ?? 70) / 100;

    // Learned calibration (item 12): once we know how a person's *actual* enjoyment
    // compared to what their stated tastes predicted (per genre), fold that residual
    // back in — small and bounded — so the model tracks reality over nights.
    let calib = 0;
    if (calibration && cand.genres.length) {
      calib = mean(cand.genres.map((g) => calibration[g] || 0));
    }

    const w = WEIGHTS.utility;
    return w.genre * genreScore + w.mood * moodScore + w.quality * qualityScore + w.calibration * calib;
  }

  // =========================================================================
  // Stage 0 — feasibility. Apply hard constraints; relax runtime if forced.
  // =========================================================================
  function applyConstraints(crew, catalog, constraints) {
    const filteredOut = [];
    const relaxations = [];
    const cx = constraints || {};
    const maxRating = typeof cx.maxRatingLevel === 'number' ? cx.maxRatingLevel : Infinity;
    const blockedWarnings = new Set((cx.blockedWarnings || []).map((w) => String(w).toLowerCase()));

    // The binding runtime cap is the smallest of everyone's personal caps AND any
    // group cap (e.g. a school-night limit, item 11).
    const capsGiven = crew
      .map((p) => p.runtimeCap)
      .filter((c) => typeof c === 'number' && c > 0);
    const groupRuntimeCap = (typeof cx.groupRuntimeCap === 'number' && cx.groupRuntimeCap > 0)
      ? cx.groupRuntimeCap : Infinity;
    if (groupRuntimeCap !== Infinity) capsGiven.push(groupRuntimeCap);
    let groupCap = capsGiven.length ? Math.min(...capsGiven) : Infinity;
    // Who owns the binding cap — a person's name, or the group label if the
    // school-night cap is the tightest.
    const capOwner = (groupRuntimeCap === groupCap && groupRuntimeCap !== Infinity)
      ? (cx.groupRuntimeLabel || 'the group')
      : (crew.find((p) => p.runtimeCap === groupCap)?.name);

    // Sacred reasons — vetoes, the content-rating cap, and content-warning filters
    // (item 11). These are NEVER relaxed: "kids are here" and "no gore" are safety
    // rails, not preferences. Only the runtime cap below is negotiable.
    const sacredReasons = (cand) => {
      const reasons = [];
      for (const p of crew) {
        for (const g of cand.genres) {
          if ((p.genres?.[g]) === 'veto') reasons.push({ type: 'veto', by: p.name, genre: g });
        }
      }
      if (typeof cand.ratingLevel === 'number' && cand.ratingLevel > maxRating) {
        reasons.push({ type: 'rating', cap: cx.maxRatingLabel || maxRating, rating: cand.certification || cand.ratingLevel, by: cx.ratingLabel || 'kids are here' });
      }
      if (blockedWarnings.size && Array.isArray(cand.warnings)) {
        for (const w of cand.warnings) if (blockedWarnings.has(String(w).toLowerCase())) reasons.push({ type: 'warning', warning: w });
      }
      return reasons;
    };

    const evaluate = (cap) => {
      const feasible = [];
      const cut = [];
      for (const cand of catalog) {
        const reasons = sacredReasons(cand);
        // Runtime cap — the one negotiable hard constraint.
        if (cand.runtime > cap) {
          reasons.push({ type: 'runtime', cap, over: cand.runtime, by: capOwner });
        }
        if (reasons.length) cut.push({ cand, reasons });
        else feasible.push(cand);
      }
      return { feasible, cut };
    };

    let { feasible, cut } = evaluate(groupCap);

    // If runtime alone emptied the menu, relax the cap up to the shortest option
    // that survives ALL sacred constraints — so we never relax our way past a
    // veto, a rating cap, or a content warning.
    if (feasible.length === 0) {
      const survives = catalog.filter((cand) => sacredReasons(cand).length === 0);
      if (survives.length) {
        const shortest = Math.min(...survives.map((c) => c.runtime));
        if (shortest > groupCap) {
          relaxations.push({ type: 'runtime', from: groupCap, to: shortest, by: capOwner });
          groupCap = shortest;
          ({ feasible, cut } = evaluate(groupCap));
        }
      }
    }

    filteredOut.push(...cut);
    return { feasible, filteredOut, groupCap, relaxations };
  }

  // =========================================================================
  // Stage 1 (cont.) — normalise utilities *within each person*.
  // =========================================================================
  // Interpersonal comparison is the classic trap: one person rates everything
  // 8–10, another 2–5. Comparing raw numbers hands the group to whoever uses a
  // wider scale. So per person we min-max their utilities across the feasible
  // menu: their best option = 1, their worst = 0. A person who is genuinely
  // indifferent (no spread) is marked as such and parked at a neutral 0.6 so
  // they neither dominate the fairness floor nor get falsely called "thrilled".
  function normaliseUtilities(crew, feasible, calibration) {
    const raw = {};   // candId -> { name: rawUtility }
    for (const cand of feasible) {
      raw[cand.id] = {};
      for (const p of crew) raw[cand.id][p.name] = rawUtility(p, cand, calibration && calibration[p.name]);
    }

    const norm = {};  // candId -> { name: 0..1 }
    const indifferent = {}; // name -> bool
    for (const p of crew) {
      const vals = feasible.map((c) => raw[c.id][p.name]);
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      const range = hi - lo;
      indifferent[p.name] = range < 1e-9;
      for (const cand of feasible) {
        norm[cand.id] = norm[cand.id] || {};
        norm[cand.id][p.name] = indifferent[p.name]
          ? 0.6
          : clamp01((raw[cand.id][p.name] - lo) / range);
      }
    }
    return { raw, norm, indifferent };
  }

  // =========================================================================
  // Stage 2 — group metrics per candidate.
  // =========================================================================
  function groupMetrics(crew, feasible, norm, weights) {
    const names = crew.map((p) => p.name);
    const w = weightsFor(crew, weights);
    const ws = names.map((n) => w[n] ?? 1);
    const metrics = {}; // candId -> { welfare, floor, nash, disagreement }

    for (const cand of feasible) {
      const us = names.map((n) => norm[cand.id][n]);
      metrics[cand.id] = {
        // welfare, nash and disagreement are conviction-weighted (item 9); the
        // floor stays a pure min — the least-happy person is protected regardless
        // of how loudly anyone else claims to care.
        welfare: wmean(us, ws),
        floor: Math.min(...us),
        nash: us.reduce((prod, u, i) => prod * Math.pow(u + WEIGHTS.nashFloor, ws[i]), 1),
        disagreement: wstdev(us, ws),
      };
    }

    // Copeland: for every ordered pair, does a (conviction-weighted) majority
    // prefer A to B? Copeland score = share of other options A beats head-to-head.
    // A score of 1 means A is a Condorcet winner (beats *everything* in majority
    // match-ups) — the strongest possible democratic mandate.
    const ids = feasible.map((c) => c.id);
    for (const a of ids) {
      let wins = 0, losses = 0;
      for (const b of ids) {
        if (a === b) continue;
        let prefA = 0, prefB = 0;
        names.forEach((n, i) => {
          const ua = norm[a][n], ub = norm[b][n];
          if (ua > ub) prefA += ws[i];
          else if (ub > ua) prefB += ws[i];
        });
        if (prefA > prefB + 1e-9) wins++;
        else if (prefB > prefA + 1e-9) losses++;
      }
      metrics[a].copelandWins = wins;
      metrics[a].copelandLosses = losses;
      metrics[a].copeland = ids.length > 1 ? wins / (ids.length - 1) : 0.5;
    }

    // Normalise the Nash product across the menu so it's comparable to the
    // other 0..1 metrics in the composite.
    const nashVals = feasible.map((c) => metrics[c.id].nash);
    const nLo = Math.min(...nashVals), nHi = Math.max(...nashVals);
    const nRange = nHi - nLo;
    for (const cand of feasible) {
      metrics[cand.id].nashNorm = nRange < 1e-9 ? 1 : (metrics[cand.id].nash - nLo) / nRange;
    }

    return metrics;
  }

  // =========================================================================
  // Stage 3 — fairness memory ("compromise debt").
  // =========================================================================
  // memory = { debt: { name: number }, history: [ ... ] }
  // debt accumulates for people who repeatedly get picks they don't love. We
  // turn it into a signed per-candidate bonus based on how the owed people do
  // *relative to that option's own average*:
  //   • positive when the owed person does BETTER than the group average here
  //     (this option is a chance to pay them back),
  //   • negative when the owed person is the one being sacrificed (avoid making
  //     the same person compromise yet again).
  // This is the key: it doesn't just chase options the owed person "likes" in
  // absolute terms (an option can be everyone's-fine yet still stiff them); it
  // moves *away* from options where they're the low scorer. Two safeguards keep
  // taste in charge: shares sum to 1 (it redistributes attention, never inflates)
  // and a saturating magnitude (a little unfairness barely registers; sustained
  // unfairness saturates). Safety-gated again in composite().
  function fairnessBonus(crew, feasible, norm, memory, weights) {
    const debt = (memory && memory.debt) || {};
    const names = crew.map((p) => p.name);
    const w = weightsFor(crew, weights);
    const ws = names.map((n) => w[n] ?? 1);
    const debts = names.map((n) => Math.max(0, debt[n] || 0));
    const total = debts.reduce((s, d) => s + d, 0);

    const bonus = {};
    if (total <= 1e-9) {
      for (const c of feasible) bonus[c.id] = 0;
      return { bonus, shares: {}, magnitude: 0 };
    }
    const shares = {};
    names.forEach((n, i) => { shares[n] = debts[i] / total; });
    // Saturating ramp: a person who's been the low scorer a couple of nights in
    // a row builds enough magnitude to matter; it caps at 1 so it can't run away.
    const magnitude = clamp01(total / (names.length * 0.35));

    for (const c of feasible) {
      const us = names.map((n) => norm[c.id][n]);
      const avg = wmean(us, ws);
      let s = 0;
      names.forEach((n, i) => { s += shares[n] * (us[i] - avg); }); // signed, ~[-1,1]
      bonus[c.id] = magnitude * s;
    }
    return { bonus, shares, magnitude };
  }

  // =========================================================================
  // Stage 4 — composite score + transparent tie-break ladder.
  // =========================================================================
  function composite(cand, metrics, fair, bestFloor) {
    const m = metrics[cand.id];
    const w = WEIGHTS.composite;
    // Safety gate on fairness: an option at or above the best achievable floor is
    // fully "fair game" (safety = 1); one that dips a full band below it earns no
    // fairness boost at all (safety = 0), with a linear ramp between. So "whose
    // turn is it" can decide among options that keep everyone happy, but can never
    // lift an option that would strand someone — the floor term still rules misery.
    const band = WEIGHTS.safetyBand;
    const safety = (typeof bestFloor === 'number')
      ? clamp01((m.floor - (bestFloor - band)) / band)
      : 1;
    return (
      w.floor * m.floor +
      w.welfare * m.welfare +
      w.nash * m.nashNorm +
      w.copeland * m.copeland +
      w.fairness * safety * (fair.bonus[cand.id] || 0) -
      w.disagreement * Math.min(1, 2 * m.disagreement)
    );
  }

  // Ordered, legible tie-breakers. Each returns a comparator among a shortlist.
  // We report which rung actually decided it, so the explanation can be honest.
  const TIEBREAK_LADDER = [
    { key: 'floor',    label: 'protecting the least-happy person', get: (m) => m.floor },
    { key: 'copeland', label: 'winning more head-to-head match-ups', get: (m) => m.copeland },
    { key: 'nashNorm', label: 'the best balance across everyone', get: (m) => m.nashNorm },
    { key: 'disagreement', label: 'being the least polarising', get: (m) => -m.disagreement },
  ];

  function breakTie(shortlist, metrics, fair, rng) {
    let pool = shortlist.slice();
    for (const rung of TIEBREAK_LADDER) {
      const scored = pool.map((c) => ({ c, v: rung.get(metrics[c.id]) }));
      const best = Math.max(...scored.map((s) => s.v));
      const survivors = scored.filter((s) => s.v > best - 1e-9).map((s) => s.c);
      if (survivors.length === 1) {
        return { winner: survivors[0], decidedBy: rung.label, coinFlip: false };
      }
      pool = survivors;
    }
    // Still tied after fairness too — genuine dead heat. Seeded coin flip, and
    // we admit it. Sorting by id first makes the flip reproducible.
    pool.sort((a, b) => a.id.localeCompare(b.id));
    const winner = pool[Math.floor(rng() * pool.length)];
    return { winner, decidedBy: 'a coin flip (a genuine dead heat)', coinFlip: true };
  }

  // =========================================================================
  // The method family — every serious single-winner rule, side by side.
  // =========================================================================
  // The composite is our considered blend. But the honest way to gauge how
  // *legitimate* a group choice is, is to ask whether the canonical aggregation
  // rules — which embody genuinely different fairness philosophies — happen to
  // agree. When rules from "greatest total" to "protect the least-happy" to the
  // Condorcet family all land on the same title, that's about as close to
  // objective as group choice gets. When they split, that disagreement IS the
  // story. Below: the primitives (rankings, pairwise matrix) and each rule, all
  // conviction-weighted (item 9) and all deterministic (id tie-breaks throughout).

  // Weighted pairwise support matrix. P[a][b] = total weight of voters who strictly
  // prefer a to b; margin = P[a][b] − P[b][a]. The substrate for Copeland, Kemeny,
  // Schulze, Ranked Pairs and Condorcet.
  function pairwiseMatrix(ids, norm, names, ws) {
    const P = {}; ids.forEach((a) => { P[a] = {}; ids.forEach((b) => { P[a][b] = 0; }); });
    names.forEach((n, i) => {
      const w = ws[i];
      for (const a of ids) for (const b of ids) if (a !== b && norm[a][n] > norm[b][n]) P[a][b] += w;
    });
    const margin = {}; ids.forEach((a) => { margin[a] = {}; ids.forEach((b) => { margin[a][b] = P[a][b] - P[b][a]; }); });
    return { P, margin };
  }

  // Kemeny–Young (item 7). THE gold standard: the full ranking that minimises total
  // pairwise disagreement — i.e. the order that the fewest voter-vs-pair preferences
  // have to be overruled to produce. NP-hard in general, but exact and fast on the
  // top finalists via a Held–Karp DP over subsets: dp[S] = the least disagreement
  // to order exactly the set S, choosing which element sits LAST within S. O(2^K·K),
  // trivial for K ≤ 8. Returns the consensus order plus how much dissent it carries.
  function kemenyYoung(finalists, P) {
    const K = finalists.length;
    if (K === 0) return { order: [], disagreements: 0, totalPairwise: 0, agreement: 1, inversions: 0 };
    if (K === 1) return { order: finalists.slice(), disagreements: 0, totalPairwise: 0, agreement: 1, inversions: 0 };
    const idx = finalists;
    const cost = (l, S) => { // disagreement of placing l below everyone else in S
      let c = 0;
      for (let u = 0; u < K; u++) if ((S & (1 << u)) && u !== l) c += P[idx[l]][idx[u]];
      return c;
    };
    const full = (1 << K) - 1;
    const dp = new Float64Array(1 << K).fill(Infinity);
    const pick = new Int8Array(1 << K).fill(-1);
    dp[0] = 0;
    for (let S = 1; S <= full; S++) {
      for (let l = 0; l < K; l++) {
        if (!(S & (1 << l))) continue;
        const prev = S ^ (1 << l);
        const v = dp[prev] + cost(l, prev);
        if (v < dp[S] - 1e-12) { dp[S] = v; pick[S] = l; }
      }
    }
    // Reconstruct: pick[S] is the LAST element of S → walk down, then reverse.
    const worstToBest = [];
    for (let S = full; S > 0;) { const l = pick[S]; worstToBest.push(idx[l]); S ^= (1 << l); }
    const order = worstToBest.reverse();
    // Consensus strength: fraction of pairwise voter-preferences the order respects,
    // and how many unordered pairs it had to rank against their own majority (cycles).
    let totalPairwise = 0, inversions = 0;
    for (let i = 0; i < K; i++) for (let j = i + 1; j < K; j++) {
      const a = idx[i], b = idx[j];
      totalPairwise += P[a][b] + P[b][a];
    }
    for (let i = 0; i < order.length; i++) for (let j = i + 1; j < order.length; j++) {
      // order[i] ranked above order[j]; an inversion is when the majority preferred order[j]
      if (P[order[j]][order[i]] > P[order[i]][order[j]] + 1e-9) inversions++;
    }
    const disagreements = dp[full];
    const agreement = totalPairwise > 0 ? 1 - disagreements / totalPairwise : 1;
    return { order, disagreements, totalPairwise, agreement, inversions };
  }

  // Schulze (beatpath). Winner = the candidate whose strongest indirect "beatpaths"
  // dominate everyone else's. Floyd–Warshall widest path over the pairwise graph.
  function schulzeOrder(ids, P) {
    const p = {}; ids.forEach((a) => { p[a] = {}; ids.forEach((b) => { p[a][b] = (a !== b && P[a][b] > P[b][a]) ? P[a][b] : 0; }); });
    for (const k of ids) for (const i of ids) if (i !== k) for (const j of ids) if (j !== i && j !== k) {
      const via = Math.min(p[i][k], p[k][j]);
      if (via > p[i][j]) p[i][j] = via;
    }
    const order = [...ids].sort((a, b) => (p[b][a] - p[a][b]) || (a < b ? -1 : a > b ? 1 : 0));
    return { order, winner: order[0], strengths: p };
  }

  // Ranked Pairs (Tideman). Lock in the biggest majorities first, skipping any that
  // would create a cycle; the resulting acyclic order's source is the winner.
  function rankedPairsOrder(ids, margin) {
    const pairs = [];
    for (const a of ids) for (const b of ids) if (a !== b && margin[a][b] > 1e-9) pairs.push([a, b, margin[a][b]]);
    pairs.sort((x, y) => (y[2] - x[2]) || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0) || (x[1] < y[1] ? -1 : 1));
    const adj = {}; ids.forEach((a) => { adj[a] = new Set(); });
    const reaches = (s, t) => { // t reachable from s in the locked graph?
      const seen = new Set([s]); const st = [s];
      while (st.length) { const u = st.pop(); for (const v of adj[u]) { if (v === t) return true; if (!seen.has(v)) { seen.add(v); st.push(v); } } }
      return false;
    };
    for (const [a, b] of pairs) if (!reaches(b, a)) adj[a].add(b); // add a→b unless it closes a cycle
    // Kahn topological sort with deterministic id tie-break.
    const indeg = {}; ids.forEach((a) => { indeg[a] = 0; });
    for (const a of ids) for (const b of adj[a]) indeg[b]++;
    const remaining = new Set(ids); const order = [];
    while (remaining.size) {
      const avail = [...remaining].filter((a) => indeg[a] === 0).sort((x, y) => (x < y ? -1 : 1));
      const a = avail.length ? avail[0] : [...remaining].sort()[0]; // guard against residual cycles
      order.push(a); remaining.delete(a);
      for (const b of adj[a]) if (remaining.has(b)) indeg[b]--;
    }
    return { order, winner: order[0] };
  }

  // Single Transferable Vote / instant-runoff (single winner). Repeatedly eliminate
  // the option with the least first-choice (conviction-weighted) support, transfer
  // each voter to their top surviving option, until one holds a majority.
  function stvWinner(ids, norm, names, ws) {
    const remaining = new Set(ids);
    const totalW = ws.reduce((a, b) => a + b, 0);
    const rounds = [];
    while (remaining.size > 1) {
      const tally = {}; remaining.forEach((id) => { tally[id] = 0; });
      names.forEach((n, i) => {
        let best = null, bv = -Infinity;
        for (const id of remaining) { const v = norm[id][n]; if (v > bv + 1e-12 || (Math.abs(v - bv) < 1e-12 && (best === null || id < best))) { bv = v; best = id; } }
        if (best != null) tally[best] += ws[i];
      });
      let leader = null, lv = -Infinity;
      for (const id of remaining) if (tally[id] > lv) { lv = tally[id]; leader = id; }
      if (lv > totalW / 2 + 1e-9) return { winner: leader, rounds };
      let loser = null, sv = Infinity;
      for (const id of remaining) { if (tally[id] < sv - 1e-9 || (Math.abs(tally[id] - sv) < 1e-9 && (loser === null || id > loser))) { sv = tally[id]; loser = id; } }
      rounds.push({ eliminated: loser });
      remaining.delete(loser);
    }
    return { winner: [...remaining][0], rounds };
  }

  // Majority Judgment (Balinski–Laraki). Voters grade each option; the winner has the
  // highest median grade, tie-broken by the majority gauge (how much weight sits above
  // vs below that median). Grades come from the normalised satisfaction bands.
  const MJ_GRADE = (u) => (u >= 0.85 ? 4 : u >= 0.65 ? 3 : u >= 0.45 ? 2 : u >= 0.2 ? 1 : 0);
  function majorityJudgment(ids, norm, names, ws) {
    const totalW = ws.reduce((a, b) => a + b, 0) || 1;
    const gauge = {};
    for (const id of ids) {
      const graded = names.map((n, i) => ({ g: MJ_GRADE(norm[id][n]), w: ws[i] })).sort((a, b) => a.g - b.g);
      let acc = 0, median = 0;
      for (const x of graded) { acc += x.w; if (acc >= totalW / 2 - 1e-9) { median = x.g; break; } }
      let above = 0, below = 0;
      graded.forEach((x) => { if (x.g > median) above += x.w; else if (x.g < median) below += x.w; });
      // majority gauge: median, pushed up by proponents or down by opponents.
      gauge[id] = median + (above >= below ? above : -below) / (2 * totalW);
    }
    const order = [...ids].sort((a, b) => (gauge[b] - gauge[a]) || (a < b ? -1 : 1));
    return { order, winner: order[0], gauge };
  }

  // Approval. Each voter approves the options they like more than their own average
  // (a self-calibrating threshold — immune to scale). Most weighted approvals wins.
  function approvalWinner(ids, norm, names, ws) {
    const counts = {}; ids.forEach((id) => { counts[id] = 0; });
    names.forEach((n, i) => {
      const vals = ids.map((id) => norm[id][n]);
      const thr = mean(vals);
      for (const id of ids) if (norm[id][n] >= thr - 1e-9) counts[id] += ws[i];
    });
    const order = [...ids].sort((a, b) => (counts[b] - counts[a]) || (a < b ? -1 : 1));
    return { order, winner: order[0], counts };
  }

  // The full panel: every rule's single winner, the Kemeny consensus order, and the
  // Condorcet winner if one exists. `weights` is an optional name→weight map.
  function methodPanel(feasible, norm, metrics, names, weights) {
    const ids = feasible.map((c) => c.id);
    const ws = names.map((n) => (weights && weights[n]) ?? 1);
    const argmax = (score) => ids.reduce((best, id) => (score(id) > score(best) ? id : best), ids[0]);

    // Borda: each person ranks the menu; an option earns (M−1−position) × weight.
    const borda = {};
    ids.forEach((id) => (borda[id] = 0));
    names.forEach((n, i) => {
      const order = [...ids].sort((a, b) => (norm[b][n] - norm[a][n]) || (a < b ? -1 : 1));
      order.forEach((id, r) => { borda[id] += ws[i] * (ids.length - 1 - r); });
    });

    const { P, margin } = pairwiseMatrix(ids, norm, names, ws);

    // Kemeny on the top finalists (by welfare) — exact and tractable there.
    const finalists = [...ids].sort((a, b) => (metrics[b].welfare - metrics[a].welfare) || (a < b ? -1 : 1)).slice(0, Math.min(8, ids.length));
    const kemeny = kemenyYoung(finalists, P);
    const schulze = schulzeOrder(ids, P);
    const tideman = rankedPairsOrder(ids, margin);
    const stv = stvWinner(ids, norm, names, ws);
    const mj = majorityJudgment(ids, norm, names, ws);
    const approval = approvalWinner(ids, norm, names, ws);

    const winners = {
      utilitarian: argmax((id) => metrics[id].welfare),
      egalitarian: argmax((id) => metrics[id].floor + 1e-6 * metrics[id].welfare),
      nash:        argmax((id) => metrics[id].nash),
      borda:       argmax((id) => borda[id] + 1e-6 * metrics[id].welfare),
      copeland:    argmax((id) => metrics[id].copeland + 1e-9 * metrics[id].welfare),
      kemeny:      kemeny.order[0] ?? ids[0],
      schulze:     schulze.winner,
      rankedPairs: tideman.winner,
      stv:         stv.winner,
      majority:    mj.winner,
      approval:    approval.winner,
    };
    // A *true* Condorcet winner beats every other option in a majority match-up.
    const condorcet = ids.length > 1
      ? (ids.find((id) => metrics[id].copelandWins === ids.length - 1) || null)
      : (ids[0] || null);

    return { winners, condorcet, borda, kemeny, orders: { schulze: schulze.order, rankedPairs: tideman.order, majority: mj.order, approval: approval.order } };
  }

  const METHOD_LABELS = {
    utilitarian: 'Greatest total',
    egalitarian: 'Protect the least-happy',
    nash: 'Fairest split',
    borda: 'Ranked-choice (Borda)',
    copeland: 'Head-to-head (Copeland)',
    kemeny: 'Fewest overruled (Kemeny)',
    schulze: 'Beatpath (Schulze)',
    rankedPairs: 'Ranked pairs (Tideman)',
    stv: 'Instant runoff (STV)',
    majority: 'Median grade (Majority Judgment)',
    approval: 'Most-approved',
  };
  // Grouping for the read-out: which philosophical family each rule belongs to.
  const METHOD_FAMILY = {
    utilitarian: 'welfare', nash: 'welfare',
    egalitarian: 'egalitarian',
    borda: 'positional', stv: 'positional', approval: 'positional', majority: 'positional',
    copeland: 'condorcet', kemeny: 'condorcet', schulze: 'condorcet', rankedPairs: 'condorcet',
  };

  // Majority preference between two options: +1 if a (conviction-weighted) majority
  // prefer a to b, -1 the other way, 0 for a tie. The building block for Condorcet
  // reasoning. `weights` is an optional name→weight map (defaults to 1 each).
  function majorityBeats(norm, names, a, b, weights) {
    let pa = 0, pb = 0;
    for (const n of names) {
      const w = (weights && weights[n]) ?? 1;
      const ua = norm[a][n], ub = norm[b][n];
      if (ua > ub) pa += w; else if (ub > ua) pb += w;
    }
    return pa > pb + 1e-9 ? 1 : (pb > pa + 1e-9 ? -1 : 0);
  }

  // When no option beats all others (no Condorcet winner), a *cycle* exists —
  // the rock-paper-scissors of taste. Surface a concrete 3-cycle among the top
  // finalists so the deadlock is legible rather than mysterious.
  function findCycle(feasible, norm, names, ranking, weights) {
    const top = ranking.slice(0, Math.min(6, ranking.length)).map((r) => r.candidate);
    for (let i = 0; i < top.length; i++)
      for (let j = 0; j < top.length; j++)
        for (let k = 0; k < top.length; k++) {
          if (i === j || j === k || i === k) continue;
          if (majorityBeats(norm, names, top[i].id, top[j].id, weights) > 0 &&
              majorityBeats(norm, names, top[j].id, top[k].id, weights) > 0 &&
              majorityBeats(norm, names, top[k].id, top[i].id, weights) > 0) {
            return [top[i].title, top[j].title, top[k].title];
          }
        }
    return null;
  }

  // =========================================================================
  // Orchestration — resolve()
  // =========================================================================
  function resolve(crew, catalog, options, memory) {
    options = options || {};
    const exclude = new Set(options.exclude || []); // ids to drop (used by re-roll)
    const seed = options.seed || crew.map((p) => p.name).sort().join('|');
    const rng = makeRng(seed + '::' + [...exclude].sort().join(','));

    if (!crew || crew.length < 2) {
      throw new Error('Need at least two people to break a deadlock.');
    }

    // "Seen it" is a soft, remembered exclusion: the crew has watched these
    // together, so drop them (you can always unmark to allow a rewatch).
    const seen = new Set(options.seen || (memory && memory.seen) || []);
    const menuAll = catalog.filter((c) => !exclude.has(c.id));
    const seenCuts = menuAll
      .filter((c) => seen.has(c.id))
      .map((c) => ({ cand: c, reasons: [{ type: 'seen' }] }));
    const menu = menuAll.filter((c) => !seen.has(c.id));

    const names = crew.map((p) => p.name);
    const weights = convictionWeights(crew);                     // conviction (item 9)
    const calibration = (memory && memory.calibration) || null;  // learned feedback (item 12)
    const constraints = options.constraints || null;             // group composition (item 11)

    const { feasible, filteredOut, groupCap, relaxations } = applyConstraints(crew, menu, constraints);
    filteredOut.push(...seenCuts);

    if (feasible.length === 0) {
      const allSeen = seenCuts.length > 0 && menu.length === 0;
      return {
        pick: null,
        empty: true,
        reason: allSeen
          ? "Everything's either vetoed or already seen. Unmark something you'd rewatch, or drop a veto."
          : 'Every option is off the table — the vetoes between you leave nothing. Drop a veto and try again.',
        filteredOut, relaxations, ranking: [],
      };
    }

    const { raw, norm, indifferent } = normaliseUtilities(crew, feasible, calibration);
    const metrics = groupMetrics(crew, feasible, norm, weights);
    const fair = fairnessBonus(crew, feasible, norm, memory, weights);
    const bestFloor = Math.max(...feasible.map((c) => metrics[c.id].floor));

    const ranking = feasible
      .map((c) => ({
        candidate: c,
        score: composite(c, metrics, fair, bestFloor),
        metrics: metrics[c.id],
        perPerson: crew.map((p) => ({
          name: p.name,
          util: norm[c.id][p.name],
          indifferent: indifferent[p.name],
        })),
      }))
      .sort((a, b) => b.score - a.score);

    // Detect a near-tie at the top and resolve it via the ladder.
    const top = ranking[0].score;
    const shortlist = ranking
      .filter((r) => top - r.score <= WEIGHTS.epsilon)
      .map((r) => r.candidate);

    let tieBreak = { happened: false };
    let winner = ranking[0].candidate;
    if (shortlist.length > 1) {
      const tb = breakTie(shortlist, metrics, fair, rng);
      winner = tb.winner;
      tieBreak = {
        happened: true,
        among: shortlist.map((c) => c.title),
        decidedBy: tb.decidedBy,
        coinFlip: tb.coinFlip,
      };
      // Float the tie-break winner to the front of the ranking.
      ranking.sort((a, b) => {
        if (a.candidate.id === winner.id) return -1;
        if (b.candidate.id === winner.id) return 1;
        return b.score - a.score;
      });
    }

    const pickRow = ranking.find((r) => r.candidate.id === winner.id);
    const runnerRow = ranking.find((r) => r.candidate.id !== winner.id) || null;
    const committable = { normForPick: names.map((n) => ({ name: n, util: norm[winner.id][n] })) };

    // Lean path — used by the many hypothetical re-resolves in analyzeVerdict, which
    // only need the winner. Skips the (expensive) whole method family + prose.
    if (options.lean) {
      return { pick: winner, empty: false, pickRow, runnerRow, ranking, metrics, groupCap, tieBreak, _committable: committable };
    }

    // The whole method family, side by side (items 7 & 8).
    const panel = methodPanel(feasible, norm, metrics, names, weights);
    const byId = Object.fromEntries(feasible.map((c) => [c.id, c]));
    const methodWinners = Object.entries(panel.winners).map(([key, id]) => ({
      key, label: METHOD_LABELS[key], family: METHOD_FAMILY[key], title: byId[id] ? byId[id].title : id, id, isPick: id === winner.id,
    }));
    const agree = methodWinners.filter((m) => m.isPick).map((m) => m.key);
    // Which philosophical families back the pick — a stronger signal than a raw count,
    // since four Condorcet-family rules agreeing is less independent than four families.
    const familiesBacking = [...new Set(methodWinners.filter((m) => m.isPick).map((m) => m.family))];
    const familiesTotal = [...new Set(methodWinners.map((m) => m.family))];
    const kemeny = {
      order: panel.kemeny.order.map((id) => (byId[id] ? byId[id].title : id)),
      orderIds: panel.kemeny.order,
      winnerIsPick: panel.kemeny.order[0] === winner.id,
      agreement: panel.kemeny.agreement,
      inversions: panel.kemeny.inversions,
      disagreements: panel.kemeny.disagreements,
    };
    const methods = {
      winners: methodWinners,
      agreeCount: agree.length,
      total: methodWinners.length,
      agreeKeys: agree,
      familiesBacking, familiesTotal: familiesTotal.length,
      condorcet: panel.condorcet ? byId[panel.condorcet].title : null,
      condorcetIsPick: panel.condorcet === winner.id,
      otherTitles: [...new Set(methodWinners.filter((m) => !m.isPick).map((m) => m.title))],
      cycle: panel.condorcet ? null : findCycle(feasible, norm, names, ranking, weights),
      kemeny,
    };

    const explanation = buildExplanation({
      crew, pickRow, runnerRow, ranking, metrics, fair, methods, weights,
      filteredOut, relaxations, tieBreak, feasibleCount: feasible.length,
    });

    return {
      pick: winner,
      empty: false,
      pickRow,
      runnerRow,
      ranking,
      metrics,
      fairness: fair,
      weights,
      methods,
      kemeny,
      filteredOut,
      relaxations,
      tieBreak,
      groupCap,
      explanation,
      // handed back so the UI can commit the exact satisfactions it showed
      _committable: committable,
    };
  }

  // =========================================================================
  // Stage 5 — explanation.
  // =========================================================================
  const SATISFACTION = [
    { min: 0.85, label: 'Thrilled', tone: 'great' },
    { min: 0.65, label: 'Happy', tone: 'good' },
    { min: 0.45, label: 'Good with it', tone: 'ok' },
    { min: 0.20, label: 'Compromising', tone: 'meh' },
    { min: -1,   label: 'Taking one for the team', tone: 'bad' },
  ];
  const satisfactionLabel = (u, indifferent) =>
    indifferent ? { label: 'Easy either way', tone: 'ok' }
                : SATISFACTION.find((s) => u >= s.min);

  function buildExplanation(ctx) {
    const { crew, pickRow, runnerRow, metrics, fair, methods, filteredOut, relaxations, tieBreak, feasibleCount } = ctx;
    const pick = pickRow.candidate;
    const m = metrics[pick.id];
    const N = crew.length;

    // Confidence / margin — agreement across independent method *families* is the
    // strongest signal there is (four Condorcet-family rules agreeing is less telling
    // than four different philosophies agreeing).
    const total = (methods && methods.total) || 11;
    const frac = methods ? methods.agreeCount / total : 0;
    let confidence;
    if (tieBreak.happened && tieBreak.coinFlip) {
      confidence = 'Photo finish';
    } else if (methods && frac >= 0.8) {
      confidence = 'Strong consensus';
    } else if (methods && frac >= 0.55) {
      confidence = 'Solid majority';
    } else if (tieBreak.happened) {
      confidence = 'Edged it';
    } else {
      const gap = pickRow.score - (runnerRow ? runnerRow.score : 0);
      confidence = gap > 0.08 ? 'Clear pick' : gap > 0.03 ? 'Edged it' : 'Close call';
    }

    // Consensus across the whole family of eleven rules.
    let consensus = null;
    if (methods) {
      const others = methods.otherTitles;
      const nFam = methods.familiesBacking ? methods.familiesBacking.length : 0;
      const kem = methods.kemeny;
      const kemNote = kem
        ? (kem.winnerIsPick
            ? ` The Kemeny consensus order — the ranking that overrules the fewest of your pairwise preferences — puts it first, too.`
            : ` (The Kemeny consensus order, which minimises overruled preferences, would top-rank ${kem.order[0]}.)`)
        : '';
      if (methods.agreeCount === total) {
        consensus = `All ${total} aggregation methods — from "greatest total" to "protect the least-happy" to the Condorcet family — independently pick this. Unanimous across every fairness philosophy.${kemNote}`;
      } else if (frac >= 0.7) {
        consensus = `${methods.agreeCount} of ${total} methods land on this, spanning ${nFam} of the ${methods.familiesTotal} philosophical families${others.length ? ` (a few leaned toward ${others.slice(0, 2).join(' and ')})` : ''} — a strong, cross-checked result.${kemNote}`;
      } else if (frac >= 0.4) {
        consensus = `${methods.agreeCount} of ${total} methods pick this${others.length ? `; the rest leaned toward ${others.slice(0, 2).join(' and ')}` : ''}. A solid call rather than a landslide.${kemNote}`;
      } else if (methods.condorcetIsPick) {
        consensus = `The family splits, but this is the Condorcet winner — it beats every alternative in a straight head-to-head, the tie-breaker with the strongest claim.${kemNote}`;
      } else {
        const cyc = methods.cycle
          ? ` There's no undisputed winner at all: ${methods.cycle[0]} beats ${methods.cycle[1]}, ${methods.cycle[1]} beats ${methods.cycle[2]}, yet ${methods.cycle[2]} beats ${methods.cycle[0]} — a genuine cycle.`
          : '';
        consensus = `The methods split${others.length ? ` (others favoured ${others.slice(0, 2).join(' and ')})` : ''} — a real judgment call.${cyc} The composite settled it by leaning on fairness and the least-happy floor.${kemNote}`;
      }
    }

    // Primary reason — pick the metric that most distinguishes the winner.
    let primary;
    if (m.copeland >= 0.999 && feasibleCount > 2) {
      primary = `It's the one option that beats every single alternative head-to-head — a rare clean consensus, not just the least-bad compromise.`;
    } else if (m.floor >= 0.6 && m.floor >= m.welfare - 0.05) {
      primary = `It leaves no one out: the least-enthusiastic person here still lands at "${satisfactionLabel(m.floor).label.toLowerCase()}," which is the highest floor on the menu.`;
    } else if (m.welfare >= 0.7) {
      primary = `It's simply the most-enjoyed option across the group — the highest overall satisfaction of anything you can actually watch tonight.`;
    } else if (m.copeland >= 0.6) {
      primary = `It wins more head-to-head match-ups than anything else on the menu — most of you prefer it to most of the alternatives.`;
    } else {
      primary = `On a tough night with real disagreement, it's the best available balance between what everyone wants.`;
    }

    // Per-person breakdown.
    const perPerson = pickRow.perPerson.map((pp) => ({
      name: pp.name,
      util: pp.util,
      ...satisfactionLabel(pp.util, pp.indifferent),
    }));
    const sorted = [...perPerson].sort((a, b) => a.util - b.util);
    const leastHappy = sorted[0];
    const mostHappy = sorted[sorted.length - 1];

    // Compromise note.
    let compromiseNote = null;
    if (leastHappy && leastHappy.util < 0.45 && !leastHappy.indifferent && N > 1) {
      compromiseNote =
        `${leastHappy.name} is compromising most tonight. That's logged — next time you're this close, the tie tips their way.`;
    } else if (leastHappy && leastHappy.util >= 0.65) {
      compromiseNote = `Nobody's really settling here — even the least-keen of you is happy with it.`;
    }

    // Runner-up: name it and give the concrete reason it lost.
    let runnerUp = null;
    if (runnerRow) {
      const rm = metrics[runnerRow.candidate.id];
      let because;
      if (rm.welfare > m.welfare + 0.02 && rm.floor < m.floor - 0.02) {
        const rSorted = [...runnerRow.perPerson].sort((a, b) => a.util - b.util);
        because = `it scored a hair higher on average, but it would have stranded ${rSorted[0].name} at "${satisfactionLabel(rSorted[0].util, rSorted[0].indifferent).label.toLowerCase()}" — a worse night for someone, which this engine weights against.`;
      } else if (rm.copeland < m.copeland - 1e-6) {
        because = `it lost more head-to-head match-ups against the rest of the menu.`;
      } else if (rm.disagreement > m.disagreement + 0.03) {
        because = `it split the room more — more of a love-it-or-hate-it pick.`;
      } else if (tieBreak.happened) {
        because = `it was effectively tied, and the pick won on ${tieBreak.decidedBy}.`;
      } else {
        because = `it came up just short on the blend of fairness and overall enjoyment.`;
      }
      runnerUp = {
        title: runnerRow.candidate.title,
        year: runnerRow.candidate.year,
        because,
      };
    }

    // What got ruled out.
    const vetoCuts = filteredOut.filter((f) => f.reasons.some((r) => r.type === 'veto'));
    const runtimeCuts = filteredOut.filter(
      (f) => f.reasons.every((r) => r.type === 'runtime')
    );
    const ruledOut = [];
    if (vetoCuts.length) {
      const byPerson = {};
      for (const f of vetoCuts) {
        for (const r of f.reasons.filter((x) => x.type === 'veto')) {
          byPerson[r.by] = byPerson[r.by] || new Set();
          byPerson[r.by].add(r.genre);
        }
      }
      const parts = Object.entries(byPerson).map(
        ([who, gs]) => `${who}'s no-${[...gs].join('/').toLowerCase()} rule`
      );
      ruledOut.push(
        `${vetoCuts.length} option${vetoCuts.length > 1 ? 's' : ''} vetoed (${parts.join('; ')}).`
      );
    }
    if (runtimeCuts.length) {
      ruledOut.push(
        `${runtimeCuts.length} option${runtimeCuts.length > 1 ? 's' : ''} over your runtime limit.`
      );
    }
    const seenCuts = filteredOut.filter((f) => f.reasons.every((r) => r.type === 'seen'));
    if (seenCuts.length) {
      ruledOut.push(
        `${seenCuts.length} you've already seen together.`
      );
    }
    // Group-composition cuts (item 11): content-rating cap and content warnings.
    const ratingCuts = filteredOut.filter((f) => !f.reasons.some((r) => r.type === 'veto') && f.reasons.some((r) => r.type === 'rating'));
    if (ratingCuts.length) {
      const rr = ratingCuts[0].reasons.find((r) => r.type === 'rating');
      ruledOut.push(`${ratingCuts.length} over the ${rr && rr.cap ? rr.cap + '-' : ''}rating cap${rr && rr.by ? ` (${rr.by})` : ''}.`);
    }
    const warnCuts = filteredOut.filter((f) => !f.reasons.some((r) => r.type === 'veto' || r.type === 'rating') && f.reasons.some((r) => r.type === 'warning'));
    if (warnCuts.length) {
      const tags = [...new Set(warnCuts.flatMap((f) => f.reasons.filter((r) => r.type === 'warning').map((r) => r.warning)))];
      ruledOut.push(`${warnCuts.length} filtered for content warnings (${tags.join(', ')}).`);
    }

    // Relaxations.
    const relaxNote = relaxations.length
      ? relaxations
          .map((r) =>
            r.type === 'runtime'
              ? `Everything fit-to-time got filtered out, so the ${r.by ? r.by + "'s " : ''}runtime cap was stretched from ${r.from} to ${r.to} min to keep a real choice on the table.`
              : ''
          )
          .join(' ')
      : null;

    // Fairness ledger note (only when it plausibly mattered).
    let fairnessNote = null;
    if (fair.magnitude > 0.08) {
      const owed = Object.entries(fair.shares).filter(([, s]) => s > 0.33).map(([n]) => n);
      if (owed.length) {
        const who = owed.length === 1 ? owed[0] : owed.slice(0, -1).join(', ') + ' & ' + owed[owed.length - 1];
        const verb = owed.length === 1 ? 'was owed' : 'were owed';
        fairnessNote = `Fairness memory had a say: ${who} ${verb} from picks you've locked before, which helped settle a close call tonight.`;
      }
    }

    return {
      headline: `Tonight you're watching ${pick.title}.`,
      hook: pick.hook,
      confidence,
      primary,
      consensus,
      perPerson,
      leastHappy,
      mostHappy,
      compromiseNote,
      runnerUp,
      ruledOut,
      relaxNote,
      fairnessNote,
    };
  }

  // =========================================================================
  // commit() — fold a locked-in pick back into fairness memory.
  // =========================================================================
  // The fairness model tracks each person's *cumulative* satisfaction across all
  // the nights this crew has locked in. "Debt" is then simply how far a person
  // sits below the group's average lifetime satisfaction — i.e. who has had the
  // rawer deal over time. Deriving debt from cumulative totals (rather than
  // summing per-round shortfalls) makes it self-correcting by construction: once
  // someone has caught up on good nights, their debt is zero, no bookkeeping
  // tricks required. This is the principled version of "the same person
  // shouldn't quietly lose every time."
  function deriveDebt(cumulative, names) {
    const totals = names.map((n) => cumulative[n] || 0);
    const avg = mean(totals);
    const debt = {};
    names.forEach((n, i) => { debt[n] = Math.max(0, avg - totals[i]); });
    return debt;
  }

  function commit(memory, pick, normForPick, meta) {
    memory = memory || {};
    memory.cumulative = memory.cumulative || {};
    memory.history = memory.history || [];
    memory.seen = memory.seen || [];
    memory.nights = memory.nights || 0;

    const names = normForPick.map((x) => x.name);
    for (const { name, util } of normForPick) {
      memory.cumulative[name] = (memory.cumulative[name] || 0) + util;
    }
    memory.nights += 1;
    memory.debt = deriveDebt(memory.cumulative, names);

    memory.history.unshift({
      at: (meta && meta.at) || new Date().toISOString(),
      pickId: pick.id,
      title: pick.title,
      year: pick.year,
      satisfaction: normForPick.map((x) => ({ name: x.name, util: Math.round(x.util * 100) })),
    });
    memory.history = memory.history.slice(0, 20);
    return memory;
  }

  // Mark / unmark a title as "seen together". Persisted on the memory object so
  // it survives across sessions for this crew.
  function markSeen(memory, id, seen) {
    memory = memory || {};
    const set = new Set(memory.seen || []);
    if (seen === false) set.delete(id); else set.add(id);
    memory.seen = [...set];
    return memory;
  }

  // =========================================================================
  // recordFeedback() — the post-watch calibration loop (item 12).
  // =========================================================================
  // After a locked night, each person can say how much they ACTUALLY enjoyed the
  // pick (0..1). We compare that to the satisfaction the engine predicted for them
  // and fold the residual back into a per-person, per-genre bias with an EMA. Over
  // nights this quietly corrects each person's stated tastes toward their real ones:
  // if you keep loving the "crime" films you only marked "like", crime warms up for
  // you specifically. The bias is bounded so a single odd night can't capsize the
  // model, and it feeds straight into rawUtility via memory.calibration.
  const CALIB = { alpha: 0.34, cap: 0.6 };
  function recordFeedback(memory, pick, ratings, meta) {
    memory = memory || {};
    memory.calibration = memory.calibration || {};
    // Predicted satisfaction: prefer an explicit value, else the most recent logged
    // night for this pick, else a neutral 0.5.
    const night = (memory.history || []).find((h) => h.pickId === pick.id) || null;
    const predByName = {};
    if (night) night.satisfaction.forEach((s) => { predByName[s.name] = s.util / 100; });
    const genres = pick.genres || [];
    for (const r of ratings || []) {
      if (!r || typeof r.enjoyed !== 'number' || !r.name) continue;
      const enjoyed = Math.max(0, Math.min(1, r.enjoyed));
      const predicted = (typeof r.predicted === 'number') ? r.predicted
        : (predByName[r.name] != null ? predByName[r.name] : 0.5);
      const residual = Math.max(-1, Math.min(1, enjoyed - predicted));
      const cal = memory.calibration[r.name] = memory.calibration[r.name] || {};
      for (const g of genres) {
        const next = (1 - CALIB.alpha) * (cal[g] || 0) + CALIB.alpha * residual;
        cal[g] = Math.max(-CALIB.cap, Math.min(CALIB.cap, next));
      }
    }
    memory.feedbackLog = memory.feedbackLog || [];
    memory.feedbackLog.unshift({
      at: (meta && meta.at) || new Date().toISOString(),
      pickId: pick.id, title: pick.title,
      ratings: (ratings || []).filter((r) => r && r.name).map((r) => ({ name: r.name, enjoyed: r.enjoyed })),
    });
    memory.feedbackLog = memory.feedbackLog.slice(0, 20);
    return memory;
  }

  // =========================================================================
  // Stage 6 — robustness & strategyproofness analysis.
  // =========================================================================
  // Two questions a serious group-decision tool should be able to answer:
  //   • How *robust* is tonight's pick — would any single small change of heart
  //     flip it? (A sensitivity analysis / counterfactual.)
  //   • Is it *strategyproof* — could anyone have gotten a better night by lying
  //     about their taste? Gibbard–Satterthwaite proves no reasonable rule can be
  //     immune in general, so the honest, valuable thing is to check *tonight's*
  //     profile against the standard manipulations and report the truth.
  // Both are computed by re-resolving hypothetical profiles, so they're exact for
  // the mechanism as implemented — not hand-waving.

  // Lean winner lookup used by the analyses (which resolve many hypotheticals).
  // Forces the lean resolve path — skips the whole method family + prose, since
  // these calls only need the winning id.
  function pickWinner(crew, catalog, options, memory) {
    const r = resolve(crew, catalog, { ...(options || {}), lean: true }, memory);
    return r.empty ? null : r.pick.id;
  }

  const WARMER = { neutral: 'like', like: 'love', dislike: 'neutral' };
  const COOLER = { love: 'like', like: 'neutral', neutral: 'dislike' };

  function analyzeVerdict(crew, catalog, memory, honest) {
    if (!honest || honest.empty) return null;
    const winnerId = honest.pick.id;
    const names = crew.map((p) => p.name);
    // Each person's *true* utility over the feasible set (from the honest run).
    const trueU = {};
    honest.ranking.forEach((r) => r.perPerson.forEach((pp) => { (trueU[pp.name] = trueU[pp.name] || {})[r.candidate.id] = pp.util; }));
    const clone = (c) => ({ name: c.name, genres: { ...c.genres }, mood: { ...c.mood }, runtimeCap: c.runtimeCap, conviction: c.conviction });

    // Analyse over the realistic contender set — the honest winner plus the strongest
    // options. A single change of heart can only ever move the outcome to a genuine
    // contender, never to an obscure also-ran, so restricting the hundreds of
    // hypothetical re-resolves to this menu keeps the analysis fast without changing
    // any reachable outcome. A guard falls back to the full catalog in the rare case
    // the reduced menu wouldn't reproduce the real winner.
    let menu = honest.ranking.slice(0, Math.min(20, honest.ranking.length)).map((r) => r.candidate);
    if (pickWinner(crew, menu, {}, memory) !== winnerId) menu = catalog;
    const feasibleIds = menu.map((c) => c.id);

    // Genres worth perturbing = those present in the catalog or already voted on
    // (keeps the engine independent of any external genre list).
    const genrePool = new Set();
    catalog.forEach((c) => (c.genres || []).forEach((g) => genrePool.add(g)));
    crew.forEach((p) => Object.keys(p.genres || {}).forEach((g) => genrePool.add(g)));

    // ---- robustness: single-step genre changes, one person at a time --------
    let tested = 0, flips = 0; const pivotal = [];
    crew.forEach((p, pi) => {
      for (const g of genrePool) {
        const cur = p.genres[g] || 'neutral';
        if (cur === 'veto') continue; // don't perturb a hard constraint
        for (const nx of [WARMER[cur], COOLER[cur]]) {
          if (!nx || nx === cur) continue;
          const mc = crew.map(clone);
          if (nx === 'neutral') delete mc[pi].genres[g]; else mc[pi].genres[g] = nx;
          tested++;
          const w = pickWinner(mc, menu, {}, memory);
          if (w && w !== winnerId) {
            flips++;
            if (pivotal.length < 5) pivotal.push({ who: p.name, genre: g, from: cur, to: nx, newWinnerId: w });
          }
        }
      }
    });
    const robustness = { robust: flips === 0, flips, tested, score: tested ? 1 - flips / tested : 1, pivotal };

    // ---- formal strategyproofness: bounded exhaustive search (item 13) -------
    // Gibbard–Satterthwaite guarantees no reasonable rule is globally strategyproof,
    // so instead of a hand-picked list of "standard" lies we MEASURE it: for each
    // person we exhaustively enumerate the discrete report space the app actually
    // exposes — every genre stance over the relevant genres × every conviction level
    // (item 9) — and check whether ANY report yields an outcome they truly prefer.
    // Their honest vetoes and their stances on non-enumerated genres are held fixed,
    // so feasibility is unchanged and each alternative winner's TRUE utility is exactly
    // the honest trueU. The search is capped by a fixed budget; when a person's space
    // exceeds it we cover the most-relevant genres and flag it non-exhaustive — an
    // honest bounded search, not a hand-wave.
    const STANCES = ['dislike', 'neutral', 'like', 'love'];
    const CONVICTIONS = ['easy', 'normal', 'care'];
    const BUDGET = 800; // reports enumerated per person; keeps a verdict's analysis quick

    const genreFreq = {};
    menu.forEach((c) => (c.genres || []).forEach((g) => { genreFreq[g] = (genreFreq[g] || 0) + 1; }));
    const relevantAll = Object.keys(genreFreq).sort((a, b) => (genreFreq[b] - genreFreq[a]) || (a < b ? -1 : 1));

    const manipulators = [];
    let spaceSearched = 0, spaceExhaustive = true;
    crew.forEach((p, pi) => {
      const tu = trueU[p.name] || {};
      const honestU = tu[winnerId] != null ? tu[winnerId] : 0;
      // Vary only relevant genres this person hasn't vetoed (vetoes are a separate,
      // fixed lever — changing them would change feasibility).
      const relevantForP = relevantAll.filter((g) => (p.genres || {})[g] !== 'veto');
      let G = relevantForP.length;
      while (Math.pow(STANCES.length, G) * CONVICTIONS.length > BUDGET && G > 0) G--;
      if (G < relevantForP.length) spaceExhaustive = false;
      const genres = relevantForP.slice(0, G);
      spaceSearched += Math.pow(STANCES.length, G) * CONVICTIONS.length;

      let best = null;
      const acc = [];
      const walk = (gi) => {
        if (gi === genres.length) {
          for (const conv of CONVICTIONS) {
            const mc = crew.map(clone);
            const gmap = { ...(p.genres || {}) };                 // keep vetoes + non-enumerated stances
            genres.forEach((g, k) => { if (acc[k] === 'neutral') delete gmap[g]; else gmap[g] = acc[k]; });
            mc[pi].genres = gmap; mc[pi].conviction = conv;
            const w = pickWinner(mc, menu, {}, memory);
            if (w == null || tu[w] == null) continue;
            const gain = tu[w] - honestU;
            if (gain > 1e-6 && (!best || gain > best.gain)) best = { altId: w, gain, via: conv };
          }
          return;
        }
        for (const s of STANCES) { acc[gi] = s; walk(gi + 1); }
      };
      walk(0);
      if (best) manipulators.push({ who: p.name, gain: +best.gain.toFixed(3), altId: best.altId, via: best.via, exhaustive: G >= relevantForP.length });
    });
    const strategy = {
      strategyproof: manipulators.length === 0,
      manipulators,
      exhaustive: spaceExhaustive,
      spaceSearched,
      // Real manipulability metrics: the share of the crew with a profitable lie, and
      // the largest true-satisfaction gain anyone could extract by misreporting.
      manipulableShare: crew.length ? +(manipulators.length / crew.length).toFixed(3) : 0,
      maxGain: +manipulators.reduce((mx, m) => Math.max(mx, m.gain), 0).toFixed(3),
    };

    return { robustness, strategy };
  }

  const api = {
    resolve, commit, markSeen, recordFeedback, deriveDebt, pickWinner, analyzeVerdict,
    // exposed for tests / inspection
    rawUtility, applyConstraints, normaliseUtilities, groupMetrics,
    fairnessBonus, composite, breakTie, methodPanel, findCycle, majorityBeats,
    convictionWeights, pairwiseMatrix, kemenyYoung, schulzeOrder, rankedPairsOrder,
    stvWinner, majorityJudgment, approvalWinner,
    WEIGHTS, MOOD_AXES, METHOD_LABELS, METHOD_FAMILY, makeRng, satisfactionLabel,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DeadlockEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
