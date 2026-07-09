/* =============================================================================
 * scripts/build-catalog.mjs — generate a real catalog from TMDB.
 *
 * Fetches top-rated + popular films and top-rated series, derives the mood axes
 * / quality score from real signals (see derive.mjs), attaches real poster URLs
 * and per-region streaming providers, and writes `catalog.generated.js` in the
 * exact shape the app already consumes. Uses only Node's built-in fetch — no
 * dependencies, no build tooling; the app stays dependency-free at runtime.
 *
 *   TMDB_BEARER=<v4 read token> node scripts/build-catalog.mjs
 *   # or:  TMDB_API_KEY=<v3 key> node scripts/build-catalog.mjs
 *   # then review catalog.generated.js and:  mv catalog.generated.js catalog.js
 *
 * Get a free key at https://www.themoviedb.org/settings/api
 * ========================================================================== */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { APP_GENRES, deriveTitle } from './derive.mjs';

const BEARER = process.env.TMDB_BEARER || process.env.TMDB_READ_TOKEN;
const APIKEY = process.env.TMDB_API_KEY;
const IMG_BASE = 'https://image.tmdb.org/t/p/w500';
const REGIONS = (process.env.TMDB_REGIONS || 'US,GB,CA,AU,IN').split(',');
const TARGET = Number(process.env.CATALOG_SIZE || 60);
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'catalog.generated.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tmdb(path, params = {}) {
  const url = new URL('https://api.themoviedb.org/3' + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (APIKEY && !BEARER) url.searchParams.set('api_key', APIKEY);
  const headers = { accept: 'application/json' };
  if (BEARER) headers.authorization = 'Bearer ' + BEARER;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 429) { await sleep(1000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`TMDB ${res.status} for ${path}: ${await res.text()}`);
    return res.json();
  }
  throw new Error('TMDB rate-limited repeatedly for ' + path);
}

async function idsFrom(path, pages) {
  const ids = [];
  for (let p = 1; p <= pages; p++) {
    const data = await tmdb(path, { page: p, language: 'en-US' });
    for (const m of data.results || []) ids.push(m.id);
    await sleep(120);
  }
  return ids;
}

function detailEntry(raw, isTv) {
  // TMDB often omits episode_run_time now; fall back to the last aired episode's
  // length, then a sensible default, so series don't ship as "0 min".
  const tvRuntime = (raw.episode_run_time || [])[0]
    || (raw.last_episode_to_air && raw.last_episode_to_air.runtime) || 45;
  const normalized = isTv
    ? { ...raw, title: raw.name, release_date: raw.first_air_date, runtime: tvRuntime }
    : raw;
  const entry = deriveTitle(normalized);
  if (isTv) entry.kind = 'Series';
  if (entry.poster) entry.poster = IMG_BASE + entry.poster;   // path -> full CDN URL
  if (entry.providers) {                                       // keep only regions we care about
    const kept = {};
    for (const r of REGIONS) if (entry.providers[r]) kept[r] = entry.providers[r];
    if (Object.keys(kept).length) entry.providers = kept; else delete entry.providers;
  }
  return entry;
}

// App genre -> a representative TMDB genre id, so we can pull top titles per
// genre (top_rated alone is ~65% Drama — no good for a group picker).
const TMDB_GENRE = {
  Action: 28, Adventure: 12, Animation: 16, Comedy: 35, Crime: 80, Documentary: 99,
  Drama: 18, Fantasy: 14, Horror: 27, Romance: 10749, 'Sci-Fi': 878, Thriller: 53,
};

async function discoverIds(kind, genreId, take) {
  const data = await tmdb(`/discover/${kind}`, {
    with_genres: genreId, sort_by: 'vote_average.desc',
    'vote_count.gte': kind === 'tv' ? 400 : 1200, page: 1, language: 'en-US',
  });
  await sleep(110);
  return (data.results || []).slice(0, take).map((m) => m.id);
}

async function fetchDetails(kind, ids) {
  const isTv = kind === 'tv';
  const out = [];
  for (const id of ids) {
    try {
      const raw = await tmdb(`/${kind}/${id}`, { append_to_response: 'keywords,watch/providers', language: 'en-US' });
      if (!raw.poster_path) continue;                          // skip posterless entries
      out.push(detailEntry(raw, isTv));
      await sleep(70);
    } catch (e) { console.warn('  skip', kind, id, '-', e.message); }
  }
  return out;
}

// Quality-first, but cap each primary genre so no single genre floods the pool.
function balance(entries, target) {
  const cap = Math.ceil(target / APP_GENRES.length) + 1;
  const count = {};
  const sorted = [...entries].sort((a, b) => b.score - a.score);
  const out = [];
  for (const e of sorted) {
    if (out.length >= target) break;
    const g = e.genres[0];
    if ((count[g] || 0) >= cap) continue;
    count[g] = (count[g] || 0) + 1;
    out.push(e);
  }
  if (out.length < target) {                                   // backfill if capping left us short
    const have = new Set(out.map((e) => e.id));
    for (const e of sorted) { if (out.length >= target) break; if (!have.has(e.id)) out.push(e); }
  }
  return out;
}

export function serialize(catalog) {
  const genres = JSON.stringify(APP_GENRES);
  const axes = `[
  { key: 'brain',     low: 'Switch off',   high: 'Make me think' },
  { key: 'intensity', low: 'Cozy',         high: 'Intense'       },
  { key: 'levity',    low: 'Serious',      high: 'Light & funny' },
]`;
  return `/* =============================================================================
 * catalog.js — AUTO-GENERATED by scripts/build-catalog.mjs from TMDB.
 * Do not edit by hand; re-run the script to refresh. Mood axes + score are
 * derived from real signals (genres, runtime, rating, keywords) — see derive.mjs.
 * Generated ${new Date().toISOString().slice(0, 10)}, ${catalog.length} titles.
 * ========================================================================== */

const GENRES = ${genres};

const MOOD_AXES = ${axes};

const CATALOG = ${JSON.stringify(catalog, null, 2)};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GENRES, MOOD_AXES, CATALOG };
} else {
  const root = typeof window !== 'undefined' ? window : globalThis;
  root.GENRES = GENRES;
  root.MOOD_AXES = MOOD_AXES;
  root.CATALOG = CATALOG;
}
`;
}

async function main() {
  if (!BEARER && !APIKEY) {
    console.error('\nMissing credentials. Set TMDB_BEARER (v4 read token) or TMDB_API_KEY (v3).');
    console.error('Get one free at https://www.themoviedb.org/settings/api\n');
    process.exit(1);
  }
  console.log('Fetching a genre-diverse pool from TMDB…');
  const movieIds = new Set(), tvIds = new Set();
  for (const gid of Object.values(TMDB_GENRE)) (await discoverIds('movie', gid, 10)).forEach((id) => movieIds.add(id));
  (await idsFrom('/movie/popular', 1)).forEach((id) => movieIds.add(id));
  for (const g of ['Drama', 'Comedy', 'Crime', 'Sci-Fi', 'Animation', 'Thriller']) {
    (await discoverIds('tv', TMDB_GENRE[g], 5)).forEach((id) => tvIds.add(id));
  }
  console.log(`  detailing ${movieIds.size} films + ${tvIds.size} series…`);
  const films = await fetchDetails('movie', [...movieIds]);
  const series = await fetchDetails('tv', [...tvIds]);

  const byId = new Map();
  for (const e of [...films, ...series]) if (!byId.has(e.id)) byId.set(e.id, e);
  const pool = [...byId.values()].filter((e) => e.genres && e.genres.length && e.runtime >= 5);
  const catalog = balance(pool, TARGET).map(({ tmdbId, ...rest }) => rest);   // drop helper field

  writeFileSync(OUT, serialize(catalog));
  console.log(`\nWrote ${catalog.length} titles to catalog.generated.js`);
  console.log('Review it, then:  mv catalog.generated.js catalog.js');
}

// Only run when invoked directly (so tests can import serialize() safely).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => { console.error('\nBuild failed:', e.message); process.exit(1); });
}
