/* =============================================================================
 * scripts/enrich.mjs — derive the extra dimensions the deepened engine consumes,
 * from signals the catalog already carries. Pure, dependency-free, and shared by
 * both the TMDB rebuild (build-catalog.mjs) and the offline enrich CLI
 * (enrich-catalog.mjs), so a rebuilt catalog and a hand-refreshed one agree.
 *
 *   pace / darkness / dialogue  (item 14) — extra tone axes, LEARNED from the
 *       catalog: a raw per-title signal is standardised across the whole catalog
 *       (z-score → logistic), so each axis uses this catalog's real spread rather
 *       than authored absolutes. The same title lands differently in a different
 *       catalog — that is what "learned from the catalog" means here.
 *   novelty                     (item 10) — the surprise↔comfort dimension: high
 *       for the obscure and off-canon, low for the canonical crowd-pleasers,
 *       derived from how a title's quality/vintage ranks *within* the catalog.
 *   ratingLevel / certification (item 11) — a content-rating estimate (0 = G …
 *       4 = NC-17) for the "kids are here" cap.
 *   warnings                    (item 11) — coarse content-warning tags for the
 *       violence/gore/etc. veto filters.
 *
 * The rating/warning estimates are exactly that — estimates from genre + tone when
 * (as in the shipped catalog) no certification/keyword data is stored. The TMDB
 * rebuild path can pass real certifications/keywords straight through instead.
 * ========================================================================== */
'use strict';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const round2 = (x) => Math.round(x * 100) / 100;
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const stdev = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) * (x - m))));
};
// squash a z-score into 0..1 — gentle slope so the axis keeps resolution.
const logistic = (z, k = 1.1) => 1 / (1 + Math.exp(-k * z));

// Per-(app-)genre tendency priors for the three new axes. Averaged over a title's
// genres, then nudged by its existing mood axes, then standardised to the catalog.
//                pace  dark  dialogue
const AX = {
  Action:      [0.85, 0.45, 0.25],
  Adventure:   [0.70, 0.35, 0.35],
  Animation:   [0.60, 0.30, 0.45],
  Comedy:      [0.55, 0.20, 0.70],
  Crime:       [0.55, 0.70, 0.65],
  Documentary: [0.35, 0.45, 0.85],
  Drama:       [0.35, 0.60, 0.80],
  Fantasy:     [0.55, 0.40, 0.45],
  Horror:      [0.65, 0.85, 0.30],
  Romance:     [0.40, 0.35, 0.70],
  'Sci-Fi':    [0.60, 0.55, 0.45],
  Thriller:    [0.75, 0.70, 0.45],
};

// Raw (pre-standardisation) tone signal for a single title, from stored fields.
export function rawTone(entry) {
  const gs = (entry.genres || []).filter((g) => AX[g]);
  const base = gs.length ? gs : ['Drama'];
  let pace = 0, dark = 0, dial = 0;
  for (const g of base) { pace += AX[g][0]; dark += AX[g][1]; dial += AX[g][2]; }
  pace /= base.length; dark /= base.length; dial /= base.length;

  const rt = entry.runtime || 100;
  const intensity = entry.intensity ?? 0.5, levity = entry.levity ?? 0.5, brain = entry.brain ?? 0.5;
  pace += (intensity - 0.5) * 0.30 - clamp01((rt - 100) / 120) * 0.15;   // intense & short → fast
  dark += (0.5 - levity) * 0.50 + (intensity - 0.5) * 0.20;              // humourless & heavy → dark
  dial += (brain - 0.5) * 0.40 - (intensity - 0.5) * 0.20;              // cerebral & calm → talky
  return { pace, darkness: dark, dialogue: dial };
}

// Raw "familiarity" of a title — how canonical it is *within this catalog*. High
// for the acclaimed and long-established; the inverse becomes novelty.
export function rawFamiliarity(entry, nowYear = new Date().getFullYear()) {
  const score = entry.score ?? 70;                         // Bayesian quality (vote-weighted)
  const votes = entry.voteCount != null ? Math.log10(entry.voteCount + 10) : null; // canon-ness if present
  const age = entry.year ? clamp01((nowYear - entry.year) / 45) : 0.3;             // older ⇒ known quantity
  const canon = votes != null ? clamp01(votes / 5) : clamp01((score - 40) / 55);
  return 0.6 * canon + 0.25 * clamp01((score - 40) / 55) + 0.15 * age;
}

// Content-rating estimate (0 G · 1 PG · 2 PG-13 · 3 R · 4 NC-17) from genre + tone.
const CERT_LABEL = ['G', 'PG', 'PG-13', 'R', 'NC-17'];
export function estimateRating(entry) {
  const genres = entry.genres || [];
  const intensity = entry.intensity ?? 0.5, levity = entry.levity ?? 0.5;
  const dark = entry.darkness ?? (0.5 - (levity - 0.5));
  let r = 1.4;                                             // baseline ~PG/PG-13
  if (genres.includes('Horror')) r = 3;
  if (genres.includes('Crime') || genres.includes('Thriller')) r += 0.6;
  r += (intensity > 0.75 ? 1 : intensity > 0.6 ? 0.5 : 0);
  r += (dark > 0.75 ? 0.7 : 0);
  r += (levity < 0.2 ? 0.4 : 0);
  if ((genres.includes('Animation') || genres.includes('Adventure') || genres.includes('Comedy')) && intensity < 0.5 && !genres.includes('Horror')) {
    r = Math.min(r, 1.4);                                  // family-leaning & calm stays low
  }
  const level = Math.max(0, Math.min(4, Math.round(r)));
  return { ratingLevel: level, certification: CERT_LABEL[level] };
}

// Coarse content-warning tags from genre + tone (violence/gore/scary/disturbing).
export function estimateWarnings(entry) {
  const genres = entry.genres || [];
  const intensity = entry.intensity ?? 0.5;
  const dark = entry.darkness ?? 0.5;
  const w = new Set();
  const violent = genres.some((g) => ['Horror', 'Crime', 'Thriller', 'Action'].includes(g));
  if (violent && intensity > 0.7) w.add('violence');
  if (genres.includes('Horror') && intensity > 0.8) w.add('gore');
  if (genres.includes('Horror')) w.add('scary');
  if (dark > 0.78) w.add('disturbing');
  return [...w];
}

/**
 * enrichCatalog — add the learned axes + rating + warnings to every entry. Pure:
 * returns a new array; does not mutate the input. Standardises the three tone axes
 * and novelty across the catalog, so the values are calibrated to this exact set.
 */
export function enrichCatalog(catalog, nowYear = new Date().getFullYear()) {
  const raws = catalog.map((e) => rawTone(e));
  const fams = catalog.map((e) => rawFamiliarity(e, nowYear));

  // Learn each axis' centre and spread from the catalog, then squash.
  const learn = (vals) => {
    const m = mean(vals), s = stdev(vals);
    return (x) => (s < 1e-9 ? clamp01(x) : round2(logistic((x - m) / s)));
  };
  const paceMap = learn(raws.map((r) => r.pace));
  const darkMap = learn(raws.map((r) => r.darkness));
  const dialMap = learn(raws.map((r) => r.dialogue));
  const famMap = learn(fams);

  return catalog.map((e, i) => {
    const pace = paceMap(raws[i].pace);
    const darkness = darkMap(raws[i].darkness);
    const dialogue = dialMap(raws[i].dialogue);
    const novelty = round2(clamp01(1 - famMap(fams[i])));   // canonical ⇒ low novelty
    const withTone = { ...e, pace, darkness, dialogue, novelty };
    const { ratingLevel, certification } = estimateRating(withTone);
    const warnings = estimateWarnings(withTone);
    return { ...withTone, ratingLevel, certification, warnings };
  });
}

// The full user-facing axis set (drives the mood sliders in the app). The first
// three are the originals; the rest are the deepened model (items 10 & 14).
export const MOOD_AXES = [
  { key: 'brain', low: 'Switch off', high: 'Make me think' },
  { key: 'intensity', low: 'Cozy', high: 'Intense' },
  { key: 'levity', low: 'Serious', high: 'Light & funny' },
  { key: 'pace', low: 'Slow burn', high: 'Breakneck' },
  { key: 'darkness', low: 'Feel-good', high: 'Pitch black' },
  { key: 'dialogue', low: 'Spectacle', high: 'Dialogue-driven' },
  { key: 'novelty', low: 'Comfort rewatch', high: 'Surprise us' },
];
