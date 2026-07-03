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
    utility: { genre: 1.2, mood: 1.0, quality: 0.4 },

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

  // =========================================================================
  // Stage 1 — per-person raw utility for one candidate.
  // =========================================================================
  // Three ingredients:
  //   genre  — the strongest signal. We reward hitting something you love
  //            (max stance) but also reward broad fit (mean stance), so a film
  //            that is "one genre you love + two you dislike" doesn't score the
  //            same as one that's "loved across the board".
  //   mood   — closeness between tonight's requested mood and the film's tone
  //            across the three axes. 1 = perfect match, 0 = opposite.
  //   quality— a gentle nudge toward well-made things; deliberately low weight.
  function rawUtility(person, cand) {
    const stances = cand.genres.map((g) => stanceVal(person.genres?.[g] ?? 'neutral'));
    // (veto is filtered out before we ever get here, so no -Infinity remains)
    const genreScore = stances.length
      ? 0.6 * Math.max(...stances) + 0.4 * mean(stances)
      : 0;

    const mood = person.mood || {};
    const diffs = [];
    if (typeof mood.brain === 'number') diffs.push(Math.abs(mood.brain - cand.brain));
    if (typeof mood.intensity === 'number') diffs.push(Math.abs(mood.intensity - cand.intensity));
    if (typeof mood.levity === 'number') diffs.push(Math.abs(mood.levity - cand.levity));
    const moodScore = diffs.length ? 1 - mean(diffs) : 0.5;

    const qualityScore = (cand.score ?? 70) / 100;

    const w = WEIGHTS.utility;
    return w.genre * genreScore + w.mood * moodScore + w.quality * qualityScore;
  }

  // =========================================================================
  // Stage 0 — feasibility. Apply hard constraints; relax runtime if forced.
  // =========================================================================
  function applyConstraints(crew, catalog) {
    const filteredOut = [];
    const relaxations = [];

    // The binding group runtime cap is the *smallest* individual cap.
    const capsGiven = crew
      .map((p) => p.runtimeCap)
      .filter((c) => typeof c === 'number' && c > 0);
    let groupCap = capsGiven.length ? Math.min(...capsGiven) : Infinity;
    const capOwner = crew.find((p) => p.runtimeCap === groupCap);

    const evaluate = (cap) => {
      const feasible = [];
      const cut = [];
      for (const cand of catalog) {
        const reasons = [];
        // Vetoes — sacred, never relaxed.
        for (const p of crew) {
          for (const g of cand.genres) {
            if ((p.genres?.[g]) === 'veto') {
              reasons.push({ type: 'veto', by: p.name, genre: g });
            }
          }
        }
        // Runtime cap.
        if (cand.runtime > cap) {
          reasons.push({ type: 'runtime', cap, over: cand.runtime, by: capOwner?.name });
        }
        if (reasons.length) cut.push({ cand, reasons });
        else feasible.push(cand);
      }
      return { feasible, cut };
    };

    let { feasible, cut } = evaluate(groupCap);

    // If runtime alone emptied the menu, relax the cap up to the shortest
    // veto-surviving option so the crew always has at least one real choice.
    if (feasible.length === 0) {
      const survivesVetoes = catalog.filter((cand) =>
        !crew.some((p) => cand.genres.some((g) => (p.genres?.[g]) === 'veto'))
      );
      if (survivesVetoes.length) {
        const shortest = Math.min(...survivesVetoes.map((c) => c.runtime));
        if (shortest > groupCap) {
          relaxations.push({
            type: 'runtime',
            from: groupCap,
            to: shortest,
            by: capOwner?.name,
          });
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
  function normaliseUtilities(crew, feasible) {
    const raw = {};   // candId -> { name: rawUtility }
    for (const cand of feasible) {
      raw[cand.id] = {};
      for (const p of crew) raw[cand.id][p.name] = rawUtility(p, cand);
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
  function groupMetrics(crew, feasible, norm) {
    const names = crew.map((p) => p.name);
    const metrics = {}; // candId -> { welfare, floor, nash, disagreement }

    for (const cand of feasible) {
      const us = names.map((n) => norm[cand.id][n]);
      metrics[cand.id] = {
        welfare: mean(us),
        floor: Math.min(...us),
        nash: us.reduce((prod, u) => prod * (u + WEIGHTS.nashFloor), 1),
        disagreement: stdev(us),
      };
    }

    // Copeland: for every ordered pair, does a strict majority prefer A to B?
    // Copeland score = share of other options A beats head-to-head. A score of
    // 1 means A is a Condorcet winner (beats *everything* in majority match-ups)
    // — the strongest possible democratic mandate.
    const ids = feasible.map((c) => c.id);
    for (const a of ids) {
      let wins = 0, losses = 0;
      for (const b of ids) {
        if (a === b) continue;
        let prefA = 0, prefB = 0;
        for (const n of names) {
          const ua = norm[a][n], ub = norm[b][n];
          if (ua > ub) prefA++;
          else if (ub > ua) prefB++;
        }
        if (prefA > prefB) wins++;
        else if (prefB > prefA) losses++;
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
  function fairnessBonus(crew, feasible, norm, memory) {
    const debt = (memory && memory.debt) || {};
    const names = crew.map((p) => p.name);
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
      const avg = mean(us);
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
  // Method panel — how the canonical social-choice methods would each decide.
  // =========================================================================
  // The composite above is our considered blend. But a great way to gauge how
  // *legitimate* a group choice is, is to ask whether the classic aggregation
  // methods — which embody genuinely different fairness philosophies — happen to
  // agree. When utilitarian, egalitarian, Borda, Condorcet and Nash all land on
  // the same title, that's about as close to objective as group choice gets.
  // When they split, the disagreement itself is the honest story.
  //
  //   utilitarian  argmax mean satisfaction           (greatest total good)
  //   egalitarian  argmax the floor                   (Rawls: help the worst-off)
  //   borda        argmax summed rank points          (ranked-choice, clone-robust)
  //   copeland     argmax head-to-head wins           (Condorcet family)
  //   nash         argmax product of satisfactions    (Nash bargaining solution)
  function methodPanel(feasible, norm, metrics, names) {
    const ids = feasible.map((c) => c.id);
    const argmax = (score) => ids.reduce((best, id) => (score(id) > score(best) ? id : best), ids[0]);

    // Borda: each person ranks the menu; an option earns (M-1-position) points.
    const borda = {};
    ids.forEach((id) => (borda[id] = 0));
    for (const n of names) {
      const order = [...ids].sort((a, b) => norm[b][n] - norm[a][n]);
      order.forEach((id, i) => { borda[id] += ids.length - 1 - i; });
    }

    const winners = {
      utilitarian: argmax((id) => metrics[id].welfare),
      egalitarian: argmax((id) => metrics[id].floor + 1e-6 * metrics[id].welfare),
      borda:       argmax((id) => borda[id] + 1e-6 * metrics[id].welfare),
      copeland:    argmax((id) => metrics[id].copeland + 1e-9 * metrics[id].welfare),
      nash:        argmax((id) => metrics[id].nash),
    };
    // A *true* Condorcet winner beats every other option in a majority match-up.
    const condorcet = ids.length > 1
      ? (ids.find((id) => metrics[id].copelandWins === ids.length - 1) || null)
      : (ids[0] || null);

    return { winners, condorcet, borda };
  }

  const METHOD_LABELS = {
    utilitarian: 'Greatest total',
    egalitarian: 'Protect the least-happy',
    borda: 'Ranked-choice',
    copeland: 'Head-to-head',
    nash: 'Fairest split',
  };

  // Majority preference between two options: +1 if a strict majority prefer a to
  // b, -1 the other way, 0 for a tie. The building block for Condorcet reasoning.
  function majorityBeats(norm, names, a, b) {
    let pa = 0, pb = 0;
    for (const n of names) { const ua = norm[a][n], ub = norm[b][n]; if (ua > ub) pa++; else if (ub > ua) pb++; }
    return pa > pb ? 1 : (pb > pa ? -1 : 0);
  }

  // When no option beats all others (no Condorcet winner), a *cycle* exists —
  // the rock-paper-scissors of taste. Surface a concrete 3-cycle among the top
  // finalists so the deadlock is legible rather than mysterious.
  function findCycle(feasible, norm, names, ranking) {
    const top = ranking.slice(0, Math.min(6, ranking.length)).map((r) => r.candidate);
    for (let i = 0; i < top.length; i++)
      for (let j = 0; j < top.length; j++)
        for (let k = 0; k < top.length; k++) {
          if (i === j || j === k || i === k) continue;
          if (majorityBeats(norm, names, top[i].id, top[j].id) > 0 &&
              majorityBeats(norm, names, top[j].id, top[k].id) > 0 &&
              majorityBeats(norm, names, top[k].id, top[i].id) > 0) {
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

    const { feasible, filteredOut, groupCap, relaxations } = applyConstraints(crew, menu);
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

    const { raw, norm, indifferent } = normaliseUtilities(crew, feasible);
    const metrics = groupMetrics(crew, feasible, norm);
    const fair = fairnessBonus(crew, feasible, norm, memory);
    const bestFloor = Math.max(...feasible.map((c) => metrics[c.id].floor));
    const panel = methodPanel(feasible, norm, metrics, crew.map((p) => p.name));

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

    // Summarise how the canonical methods voted, and how many agree with the pick.
    const byId = Object.fromEntries(feasible.map((c) => [c.id, c]));
    const methodWinners = Object.entries(panel.winners).map(([key, id]) => ({
      key, label: METHOD_LABELS[key], title: byId[id].title, id, isPick: id === winner.id,
    }));
    const agree = methodWinners.filter((m) => m.isPick).map((m) => m.key);
    const methods = {
      winners: methodWinners,
      agreeCount: agree.length,
      total: methodWinners.length,
      agreeKeys: agree,
      condorcet: panel.condorcet ? byId[panel.condorcet].title : null,
      condorcetIsPick: panel.condorcet === winner.id,
      otherTitles: [...new Set(methodWinners.filter((m) => !m.isPick).map((m) => m.title))],
      cycle: panel.condorcet ? null : findCycle(feasible, norm, crew.map((p) => p.name), ranking),
    };

    const explanation = buildExplanation({
      crew, pickRow, runnerRow, ranking, metrics, fair, methods,
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
      methods,
      filteredOut,
      relaxations,
      tieBreak,
      groupCap,
      explanation,
      // handed back so the UI can commit the exact satisfactions it showed
      _committable: { normForPick: crew.map((p) => ({ name: p.name, util: norm[winner.id][p.name] })) },
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

    // Confidence / margin — cross-method agreement is the strongest signal there is.
    let confidence;
    if (tieBreak.happened && tieBreak.coinFlip) {
      confidence = 'Photo finish';
    } else if (methods && methods.agreeCount >= 4) {
      confidence = 'Strong consensus';
    } else if (tieBreak.happened) {
      confidence = 'Edged it';
    } else {
      const gap = pickRow.score - (runnerRow ? runnerRow.score : 0);
      confidence = gap > 0.08 ? 'Clear pick' : gap > 0.03 ? 'Edged it' : 'Close call';
    }

    // Consensus across the five classic methods.
    let consensus = null;
    if (methods) {
      const others = methods.otherTitles;
      if (methods.agreeCount >= 5) {
        consensus = `All five classic voting methods — from "greatest total" to "protect the least-happy" — independently pick this. Unanimous across every fairness philosophy.`;
      } else if (methods.agreeCount === 4) {
        consensus = `Four of the five classic voting methods land on this${others.length ? ` (the odd one out preferred ${others[0]})` : ''} — a strong, cross-checked result.`;
      } else if (methods.agreeCount === 3) {
        consensus = `Three of five voting methods pick this${others.length ? `; the rest leaned toward ${others.slice(0, 2).join(' and ')}` : ''}. A solid call rather than a landslide.`;
      } else if (methods.condorcetIsPick) {
        consensus = `The methods genuinely split, but this is the Condorcet winner — it beats every alternative in a straight head-to-head, which is the tie-breaker with the strongest claim.`;
      } else {
        const cyc = methods.cycle
          ? ` There's no undisputed winner at all: ${methods.cycle[0]} beats ${methods.cycle[1]}, ${methods.cycle[1]} beats ${methods.cycle[2]}, yet ${methods.cycle[2]} beats ${methods.cycle[0]} — a genuine cycle.`
          : '';
        consensus = `The methods split${others.length ? ` (others favoured ${others.slice(0, 2).join(' and ')})` : ''} — a real judgment call.${cyc} The composite settled it by leaning on fairness and the least-happy floor.`;
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
  function pickWinner(crew, catalog, options, memory) {
    const r = resolve(crew, catalog, options, memory);
    return r.empty ? null : r.pick.id;
  }

  const WARMER = { neutral: 'like', like: 'love', dislike: 'neutral' };
  const COOLER = { love: 'like', like: 'neutral', neutral: 'dislike' };

  function analyzeVerdict(crew, catalog, memory, honest) {
    if (!honest || honest.empty) return null;
    const winnerId = honest.pick.id;
    const names = crew.map((p) => p.name);
    const feasibleIds = honest.ranking.map((r) => r.candidate.id);
    const genresOf = {}; honest.ranking.forEach((r) => { genresOf[r.candidate.id] = r.candidate.genres; });
    // Each person's *true* utility over the feasible set (from the honest run).
    const trueU = {};
    honest.ranking.forEach((r) => r.perPerson.forEach((pp) => { (trueU[pp.name] = trueU[pp.name] || {})[r.candidate.id] = pp.util; }));
    const clone = (c) => ({ name: c.name, genres: { ...c.genres }, mood: { ...c.mood }, runtimeCap: c.runtimeCap });

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
          const w = pickWinner(mc, catalog, {}, memory);
          if (w && w !== winnerId) {
            flips++;
            if (pivotal.length < 5) pivotal.push({ who: p.name, genre: g, from: cur, to: nx, newWinnerId: w });
          }
        }
      }
    });
    const robustness = { robust: flips === 0, flips, tested, score: tested ? 1 - flips / tested : 1, pivotal };

    // ---- strategyproofness: can anyone gain by misreporting their taste? ----
    const manipulators = [];
    crew.forEach((p, pi) => {
      const tu = trueU[p.name] || {};
      const honestU = tu[winnerId] != null ? tu[winnerId] : 0;
      let favId = winnerId, favU = honestU;
      for (const id of feasibleIds) if ((tu[id] != null ? tu[id] : 0) > favU) { favU = tu[id]; favId = id; }
      if (favId === winnerId) return; // already got their favourite → no incentive to lie
      const fav = genresOf[favId] || [], win = genresOf[winnerId] || [];
      const misreports = [];
      misreports.push(Object.fromEntries(fav.map((x) => [x, 'love'])));                                  // boost favourite
      { const g = Object.fromEntries(fav.map((x) => [x, 'love'])); win.forEach((x) => { if (!(x in g)) g[x] = 'dislike'; }); misreports.push(g); } // bury winner + boost favourite
      { const g = { ...p.genres }; fav.forEach((x) => (g[x] = 'love')); win.forEach((x) => { if ((g[x] || 'neutral') !== 'love') g[x] = 'dislike'; }); misreports.push(g); } // extremise
      let best = null;
      for (const mg of misreports) {
        const mc = crew.map(clone); mc[pi].genres = mg;
        const w = pickWinner(mc, catalog, {}, memory);
        const gainU = (w != null && tu[w] != null) ? tu[w] - honestU : -1;
        if (gainU > 1e-9 && (!best || gainU > best.gain)) best = { altId: w, gain: gainU };
      }
      if (best) manipulators.push({ who: p.name, gain: +best.gain.toFixed(3), altId: best.altId });
    });
    const strategy = { strategyproof: manipulators.length === 0, manipulators };

    return { robustness, strategy };
  }

  const api = {
    resolve, commit, markSeen, deriveDebt, pickWinner, analyzeVerdict,
    // exposed for tests / inspection
    rawUtility, applyConstraints, normaliseUtilities, groupMetrics,
    fairnessBonus, composite, breakTie, methodPanel, findCycle, majorityBeats,
    WEIGHTS, makeRng, satisfactionLabel,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DeadlockEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
