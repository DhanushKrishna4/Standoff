/* =============================================================================
 * scripts/derive.test.js — proves the real-signal derivation (derive.mjs)
 * behaves sanely, with fixtures only. No network, no API key.
 *
 *   node scripts/derive.test.js
 * ========================================================================== */
import assert from 'node:assert/strict';
import { mapGenres, deriveMood, deriveScore, deriveTitle } from './derive.mjs';

let passed = 0;
const ok = (name) => { passed++; console.log('  \x1b[32m✓\x1b[0m ' + name); };
const inRange = (x) => x >= 0 && x <= 1;

// --- genre mapping ---
assert.deepEqual(mapGenres(['Science Fiction']), ['Sci-Fi'], 'Science Fiction -> Sci-Fi');
assert.deepEqual(mapGenres(['Family']), ['Adventure'], 'Family -> Adventure');
assert.deepEqual(mapGenres(['Mystery', 'Thriller']), ['Thriller'], 'dedupes to the same app genre');
assert.equal(mapGenres(['Action', 'Adventure', 'Comedy', 'Drama']).length, 3, 'caps at 3 genres');
ok('mapGenres maps, dedupes and caps to the app taxonomy');

// --- mood axes stay in range ---
for (const g of [['Comedy'], ['Horror'], ['Documentary'], ['Action', 'Thriller'], []]) {
  const m = deriveMood({ genreNames: g, runtime: 110, voteAverage: 7 });
  assert.ok(inRange(m.brain) && inRange(m.intensity) && inRange(m.levity), 'axes in 0..1 for ' + g);
}
ok('every mood axis stays within 0..1');

// --- axes reflect real genre character ---
const comedy = deriveMood({ genreNames: ['Comedy'], runtime: 100, voteAverage: 7 });
const horror = deriveMood({ genreNames: ['Horror'], runtime: 100, voteAverage: 7 });
const doc = deriveMood({ genreNames: ['Documentary'], runtime: 100, voteAverage: 7 });
const thriller = deriveMood({ genreNames: ['Thriller', 'Action'], runtime: 100, voteAverage: 7 });
assert.ok(comedy.levity > 0.7, 'comedy is light');
assert.ok(comedy.intensity < 0.45, 'comedy is not intense');
assert.ok(horror.intensity > 0.7, 'horror is intense');
assert.ok(horror.levity < 0.35, 'horror is not light');
assert.ok(doc.brain > 0.75, 'documentary makes you think');
assert.ok(doc.levity < comedy.levity, 'a doc is more serious than a comedy');
assert.ok(thriller.intensity > comedy.intensity, 'a thriller is more intense than a comedy');
ok('axes reflect genre character (comedy light, horror intense, doc brainy)');

// --- runtime and keyword nudges move the needle in the right direction ---
const shortDrama = deriveMood({ genreNames: ['Drama'], runtime: 90, voteAverage: 7 });
const longDrama = deriveMood({ genreNames: ['Drama'], runtime: 165, voteAverage: 7 });
assert.ok(longDrama.brain >= shortDrama.brain, 'a long drama skews at least as brainy');
assert.ok(longDrama.intensity >= shortDrama.intensity, 'a long drama skews at least as intense');
const plain = deriveMood({ genreNames: ['Drama'], runtime: 110, voteAverage: 7, keywords: [] });
const brainy = deriveMood({ genreNames: ['Drama'], runtime: 110, voteAverage: 7, keywords: ['psychological thriller'] });
assert.ok(brainy.brain > plain.brain, '"psychological" keyword raises brain');
const grim = deriveMood({ genreNames: ['Drama'], runtime: 110, voteAverage: 7, keywords: ['tragedy'] });
assert.ok(grim.levity < plain.levity, '"tragedy" keyword lowers levity');
ok('runtime and keyword signals nudge the axes correctly');

// --- score: Bayesian shrink toward the mean by vote count ---
const thin = deriveScore({ voteAverage: 9.5, voteCount: 12 });
const proven = deriveScore({ voteAverage: 9.5, voteCount: 20000 });
assert.ok(proven > thin, 'a well-voted 9.5 outranks a thinly-voted 9.5');
assert.ok(thin < 90, 'a 9.5 with 12 votes is heavily shrunk');
assert.ok(deriveScore({ voteAverage: 2, voteCount: 50000 }) >= 40, 'score floored at 40');
assert.ok(deriveScore({ voteAverage: 10, voteCount: 999999 }) <= 100, 'score capped at 100');
ok('score shrinks low-confidence ratings toward the mean and is bounded 40..100');

// --- deriveTitle produces a full, app-shaped entry ---
const entry = deriveTitle({
  id: 12345, title: 'The Test Movie', release_date: '2019-06-01', runtime: 132,
  vote_average: 8.6, vote_count: 15000, poster_path: '/abc.jpg', tagline: 'A tagline.',
  genres: [{ name: 'Thriller' }, { name: 'Drama' }, { name: 'Comedy' }],
  keywords: { keywords: [{ name: 'psychological' }] },
  'watch/providers': { results: { US: { flatrate: [{ provider_name: 'Netflix' }] }, GB: { rent: [{ provider_name: 'Apple TV' }] } } },
});
assert.equal(entry.id, 'the-test-movie', 'id is a slug of the title');
assert.equal(entry.title, 'The Test Movie');
assert.equal(entry.year, 2019);
assert.equal(entry.kind, 'Film');
assert.ok(Array.isArray(entry.genres) && entry.genres.length >= 1 && entry.genres.length <= 3, 'has 1..3 genres');
assert.ok(['brain', 'intensity', 'levity'].every((k) => inRange(entry[k])), 'mood axes present and in range');
assert.ok(entry.score >= 40 && entry.score <= 100, 'score in range');
assert.equal(entry.hook, 'A tagline.', 'uses the tagline as the hook');
assert.equal(entry.poster, '/abc.jpg', 'passes the poster path through');
assert.deepEqual(entry.providers, { US: ['Netflix'] }, 'extracts flatrate (streamable) providers only');
ok('deriveTitle emits a complete, app-shaped catalog entry');

console.log('\n\x1b[32m' + passed + ' passing\x1b[0m\n');
