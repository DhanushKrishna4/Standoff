/* =============================================================================
 * scripts/derive.mjs — turn raw TMDB signals into the catalog shape the app
 * consumes, deriving the mood axes (brain / intensity / levity) and a quality
 * score from real data instead of hand-authoring them.
 *
 * Pure and dependency-free so it can be unit-tested (see derive.test.js) with
 * fixtures — no network, no API key needed to verify the logic.
 *
 * The app's mood axes (all 0..1):
 *   brain      0 = switch off            1 = makes you think
 *   intensity  0 = cozy / calm           1 = edge-of-seat / heavy
 *   levity     0 = serious / heavy        1 = light / funny
 * ========================================================================== */
'use strict';

// The app's fixed 12-genre taxonomy.
export const APP_GENRES = [
  'Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary',
  'Drama', 'Fantasy', 'Horror', 'Romance', 'Sci-Fi', 'Thriller',
];

// TMDB genre name -> the app genre(s) it maps onto.
const GENRE_MAP = {
  Action: ['Action'], Adventure: ['Adventure'], Animation: ['Animation'],
  Comedy: ['Comedy'], Crime: ['Crime'], Documentary: ['Documentary'],
  Drama: ['Drama'], Family: ['Adventure'], Fantasy: ['Fantasy'],
  History: ['Drama'], Horror: ['Horror'], Music: ['Drama'],
  Mystery: ['Thriller'], Romance: ['Romance'], 'Science Fiction': ['Sci-Fi'],
  Thriller: ['Thriller'], War: ['Drama'], Western: ['Adventure'],
  'TV Movie': [],
};

// Per-axis weight each TMDB genre pulls toward (0..1). Averaged over a title's
// genres, then nudged by runtime / rating / keywords below.
const W = {
  //            brain intensity levity
  Action:        [0.30, 0.85, 0.45],
  Adventure:     [0.40, 0.55, 0.60],
  Animation:     [0.40, 0.40, 0.75],
  Comedy:        [0.30, 0.30, 0.90],
  Crime:         [0.60, 0.70, 0.25],
  Documentary:   [0.90, 0.35, 0.40],
  Drama:         [0.70, 0.50, 0.30],
  Family:        [0.30, 0.30, 0.85],
  Fantasy:       [0.45, 0.50, 0.60],
  History:       [0.80, 0.55, 0.30],
  Horror:        [0.50, 0.90, 0.20],
  Music:         [0.50, 0.35, 0.70],
  Mystery:       [0.75, 0.65, 0.30],
  Romance:       [0.40, 0.30, 0.65],
  'Science Fiction': [0.70, 0.60, 0.45],
  Thriller:      [0.60, 0.85, 0.25],
  War:           [0.75, 0.90, 0.15],
  Western:       [0.45, 0.60, 0.40],
  'TV Movie':    [0.40, 0.40, 0.50],
};

// Keyword nudges — matched as case-insensitive substrings of TMDB keyword names.
const KW = {
  brain: { add: ['psycholog', 'philosoph', 'based on a true story', 'based on true', 'politic', 'existential', 'twist ending', 'nonlinear', 'time travel'], sub: ['slapstick', 'parody'] },
  intensity: { add: ['violence', 'survival', 'chase', 'war ', 'gore', 'serial killer', 'suspense', 'heist', 'assassin', 'monster'], sub: ['feel-good', 'wholesome'] },
  levity: { add: ['buddy', 'satire', 'romantic comedy', 'coming of age', 'holiday', 'friendship', 'wholesome'], sub: ['tragedy', 'grief', 'dark', 'bleak', 'bleak', 'nihilis', 'death of'] },
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const round2 = (x) => Math.round(x * 100) / 100;

export function mapGenres(tmdbGenreNames) {
  const out = [];
  for (const name of tmdbGenreNames || []) {
    for (const g of GENRE_MAP[name] || []) if (!out.includes(g)) out.push(g);
  }
  return out.slice(0, 3);
}

function keywordNudge(axis, keywordNames) {
  const hay = (keywordNames || []).join(' ').toLowerCase();
  let n = 0;
  for (const t of KW[axis].add) if (hay.includes(t)) n += 0.06;
  for (const t of KW[axis].sub) if (hay.includes(t)) n -= 0.06;
  return Math.max(-0.18, Math.min(0.18, n));
}

/**
 * deriveMood — the three axes from a title's TMDB genres, runtime, rating and
 * keywords. `genreNames` are raw TMDB names; `keywords` are TMDB keyword names.
 */
export function deriveMood({ genreNames = [], runtime = 0, voteAverage = 6.5, keywords = [] }) {
  const known = genreNames.filter((g) => W[g]);
  const base = known.length ? known : ['Drama'];
  let brain = 0, intensity = 0, levity = 0;
  for (const g of base) { brain += W[g][0]; intensity += W[g][1]; levity += W[g][2]; }
  brain /= base.length; intensity /= base.length; levity /= base.length;

  // real-signal nudges
  const long = runtime ? clamp01((runtime - 100) / 140) - 0.15 : 0;   // long films skew heavier/brainier
  brain += long * 0.18 + (voteAverage - 6.5) * 0.02;
  intensity += long * 0.14;
  levity -= long * 0.10;

  brain += keywordNudge('brain', keywords);
  intensity += keywordNudge('intensity', keywords);
  levity += keywordNudge('levity', keywords);

  return { brain: round2(clamp01(brain)), intensity: round2(clamp01(intensity)), levity: round2(clamp01(levity)) };
}

/**
 * deriveScore — a 0..100 "worth-your-time" proxy from TMDB's rating, shrunk
 * toward the mean by vote count (a title with 40 votes shouldn't outrank a
 * classic with 20,000). Bayesian average, then scaled and floored.
 */
export function deriveScore({ voteAverage = 6.5, voteCount = 0 }) {
  const PRIOR_MEAN = 6.5, PRIOR_WEIGHT = 800;
  const bayes = (voteAverage * voteCount + PRIOR_MEAN * PRIOR_WEIGHT) / (voteCount + PRIOR_WEIGHT);
  return Math.max(40, Math.min(100, Math.round(bayes * 10)));
}

const slugify = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/**
 * deriveTitle — a full catalog entry (the exact shape app.js/engine.js expect,
 * plus optional `poster` and `providers`) from a TMDB movie detail payload.
 */
export function deriveTitle(movie) {
  const genreNames = (movie.genres || []).map((g) => g.name);
  const keywords = ((movie.keywords && (movie.keywords.keywords || movie.keywords.results)) || []).map((k) => k.name);
  const runtime = movie.runtime || 0;
  const year = movie.release_date ? Number(movie.release_date.slice(0, 4)) : undefined;
  const mood = deriveMood({ genreNames, runtime, voteAverage: movie.vote_average, keywords });
  const genres = mapGenres(genreNames);

  const entry = {
    id: slugify(movie.title || movie.name) || String(movie.id),
    tmdbId: movie.id,
    title: movie.title || movie.name,
    year,
    kind: 'Film',
    genres: genres.length ? genres : ['Drama'],
    runtime,
    brain: mood.brain,
    intensity: mood.intensity,
    levity: mood.levity,
    score: deriveScore({ voteAverage: movie.vote_average, voteCount: movie.vote_count }),
    hook: (movie.tagline && movie.tagline.trim()) || trimOverview(movie.overview),
  };
  if (movie.poster_path) entry.poster = movie.poster_path;   // path only; base URL added at render/build time
  const providers = extractProviders(movie['watch/providers'] || movie.watch_providers);
  if (providers && Object.keys(providers).length) entry.providers = providers;
  return entry;
}

function trimOverview(o) {
  if (!o) return '';
  const first = o.split(/(?<=[.!?])\s/)[0] || o;
  return first.length > 90 ? first.slice(0, 87).trimEnd() + '…' : first;
}

// { results: { US: { flatrate:[{provider_name}] }, ... } } -> { US:['Netflix',...] }
function extractProviders(wp) {
  const byRegion = wp && wp.results;
  if (!byRegion) return null;
  const out = {};
  for (const region of Object.keys(byRegion)) {
    const flat = byRegion[region].flatrate || [];
    const names = flat.map((p) => p.provider_name);
    if (names.length) out[region] = names;
  }
  return out;
}
