/* =============================================================================
 * catalog.js — the pool of candidates the crew chooses from.
 *
 * This is an *editorial* catalog: genres, runtimes and years are approximate,
 * and the three "mood" attributes (brain / intensity / levity) plus `score`
 * are deliberate authored judgements, not scraped data. They exist to give the
 * merging engine a rich, well-separated space to reason over. Swap in your own
 * library and the engine behaves identically.
 *
 * Mood axes (all 0..1):
 *   brain      0 = switch your brain off      1 = makes you think
 *   intensity  0 = cozy / calm                1 = edge-of-seat / heavy
 *   levity     0 = serious / heavy            1 = light / funny
 *
 * score: an editorial 0..100 "worth-your-time" proxy. Used only as a gentle
 *        nudge, never a driver — see engine.js.
 * ========================================================================== */

const GENRES = [
  'Action', 'Adventure', 'Animation', 'Comedy', 'Crime', 'Documentary',
  'Drama', 'Fantasy', 'Horror', 'Romance', 'Sci-Fi', 'Thriller',
];

const MOOD_AXES = [
  { key: 'brain',     low: 'Switch off',   high: 'Make me think' },
  { key: 'intensity', low: 'Cozy',         high: 'Intense'       },
  { key: 'levity',    low: 'Serious',      high: 'Light & funny' },
];

const CATALOG = [
  { id: 'grand-budapest', title: 'The Grand Budapest Hotel', year: 2014, kind: 'Film', genres: ['Comedy', 'Adventure'], runtime: 99, brain: 0.55, intensity: 0.35, levity: 0.80, score: 92, hook: 'A concierge, a lobby boy, and a stolen painting.' },
  { id: 'fury-road', title: 'Mad Max: Fury Road', year: 2015, kind: 'Film', genres: ['Action', 'Adventure', 'Sci-Fi'], runtime: 120, brain: 0.35, intensity: 0.98, levity: 0.25, score: 90, hook: 'One long, glorious road-rage ballet.' },
  { id: 'spirited-away', title: 'Spirited Away', year: 2001, kind: 'Film', genres: ['Animation', 'Fantasy', 'Adventure'], runtime: 125, brain: 0.60, intensity: 0.45, levity: 0.55, score: 96, hook: 'A girl, a bathhouse for spirits, a way home.' },
  { id: 'parasite', title: 'Parasite', year: 2019, kind: 'Film', genres: ['Thriller', 'Drama', 'Comedy'], runtime: 132, brain: 0.85, intensity: 0.80, levity: 0.40, score: 95, hook: 'Two families, one staircase, no easy exit.' },
  { id: 'paddington-2', title: 'Paddington 2', year: 2017, kind: 'Film', genres: ['Comedy', 'Adventure'], runtime: 103, brain: 0.30, intensity: 0.30, levity: 0.90, score: 88, hook: 'The nicest bear in cinema, wrongly imprisoned.' },
  { id: 'br-2049', title: 'Blade Runner 2049', year: 2017, kind: 'Film', genres: ['Sci-Fi', 'Drama'], runtime: 164, brain: 0.90, intensity: 0.60, levity: 0.10, score: 87, hook: 'What makes a life real? Ask a replicant.' },
  { id: 'knives-out', title: 'Knives Out', year: 2019, kind: 'Film', genres: ['Crime', 'Comedy', 'Thriller'], runtime: 130, brain: 0.70, intensity: 0.55, levity: 0.60, score: 89, hook: 'A donut of a mystery, hole in the middle.' },
  { id: 'nice-guys', title: 'The Nice Guys', year: 2016, kind: 'Film', genres: ['Comedy', 'Crime', 'Action'], runtime: 116, brain: 0.50, intensity: 0.60, levity: 0.80, score: 82, hook: 'Two bad detectives, 1970s LA, real laughs.' },
  { id: 'arrival', title: 'Arrival', year: 2016, kind: 'Film', genres: ['Sci-Fi', 'Drama'], runtime: 116, brain: 0.92, intensity: 0.50, levity: 0.20, score: 90, hook: 'If you knew how it ends, would you begin?' },
  { id: 'get-out', title: 'Get Out', year: 2017, kind: 'Film', genres: ['Horror', 'Thriller'], runtime: 104, brain: 0.80, intensity: 0.85, levity: 0.35, score: 92, hook: 'Meet the parents. Then run.' },
  { id: 'spider-verse', title: 'Spider-Man: Into the Spider-Verse', year: 2018, kind: 'Film', genres: ['Animation', 'Action', 'Adventure'], runtime: 117, brain: 0.45, intensity: 0.70, levity: 0.75, score: 94, hook: 'Anyone can wear the mask. Even you.' },
  { id: 'la-la-land', title: 'La La Land', year: 2016, kind: 'Film', genres: ['Romance', 'Drama', 'Comedy'], runtime: 128, brain: 0.50, intensity: 0.40, levity: 0.65, score: 86, hook: 'A jazz pianist, an actress, a bittersweet duet.' },
  { id: 'john-wick', title: 'John Wick', year: 2014, kind: 'Film', genres: ['Action', 'Thriller', 'Crime'], runtime: 101, brain: 0.25, intensity: 0.90, levity: 0.30, score: 82, hook: 'They killed his dog. Bad idea.' },
  { id: 'coco', title: 'Coco', year: 2017, kind: 'Film', genres: ['Animation', 'Fantasy', 'Adventure'], runtime: 105, brain: 0.40, intensity: 0.40, levity: 0.70, score: 90, hook: 'A boy, a guitar, and the land of the dead.' },
  { id: 'social-network', title: 'The Social Network', year: 2010, kind: 'Film', genres: ['Drama', 'Crime'], runtime: 120, brain: 0.80, intensity: 0.50, levity: 0.35, score: 89, hook: "You don't get 500 million friends without a few enemies." },
  { id: 'eeaao', title: 'Everything Everywhere All at Once', year: 2022, kind: 'Film', genres: ['Sci-Fi', 'Comedy', 'Adventure'], runtime: 139, brain: 0.85, intensity: 0.80, levity: 0.70, score: 92, hook: 'A tax audit across every universe at once.' },
  { id: 'whiplash', title: 'Whiplash', year: 2014, kind: 'Film', genres: ['Drama', 'Thriller'], runtime: 106, brain: 0.75, intensity: 0.90, levity: 0.15, score: 90, hook: 'Not quite my tempo.' },
  { id: 'booksmart', title: 'Booksmart', year: 2019, kind: 'Film', genres: ['Comedy'], runtime: 102, brain: 0.40, intensity: 0.40, levity: 0.85, score: 84, hook: 'Two overachievers, one night of missed fun.' },
  { id: 'dune', title: 'Dune', year: 2021, kind: 'Film', genres: ['Sci-Fi', 'Adventure', 'Drama'], runtime: 155, brain: 0.80, intensity: 0.70, levity: 0.15, score: 88, hook: 'A desert planet, a spice, a prophesied boy.' },
  { id: 'dark-knight', title: 'The Dark Knight', year: 2008, kind: 'Film', genres: ['Action', 'Crime', 'Thriller'], runtime: 152, brain: 0.70, intensity: 0.90, levity: 0.25, score: 94, hook: 'Some men just want to watch the world burn.' },
  { id: 'little-women', title: 'Little Women', year: 2019, kind: 'Film', genres: ['Drama', 'Romance'], runtime: 135, brain: 0.65, intensity: 0.35, levity: 0.55, score: 88, hook: 'Four sisters, one restless century.' },
  { id: 'baby-driver', title: 'Baby Driver', year: 2017, kind: 'Film', genres: ['Action', 'Crime', 'Romance'], runtime: 113, brain: 0.40, intensity: 0.80, levity: 0.60, score: 84, hook: 'Every getaway needs a soundtrack.' },
  { id: 'the-menu', title: 'The Menu', year: 2022, kind: 'Film', genres: ['Thriller', 'Horror', 'Comedy'], runtime: 107, brain: 0.70, intensity: 0.75, levity: 0.50, score: 82, hook: 'Dinner is served. You are the tasting menu.' },
  { id: 'palm-springs', title: 'Palm Springs', year: 2020, kind: 'Film', genres: ['Comedy', 'Romance', 'Sci-Fi'], runtime: 90, brain: 0.60, intensity: 0.45, levity: 0.80, score: 84, hook: 'Stuck in one wedding day, forever.' },
  { id: 'sicario', title: 'Sicario', year: 2015, kind: 'Film', genres: ['Thriller', 'Crime', 'Action'], runtime: 121, brain: 0.75, intensity: 0.90, levity: 0.10, score: 86, hook: 'The border has no rules, only survivors.' },
  { id: 'ratatouille', title: 'Ratatouille', year: 2007, kind: 'Film', genres: ['Animation', 'Comedy', 'Fantasy'], runtime: 111, brain: 0.45, intensity: 0.35, levity: 0.75, score: 90, hook: 'Anyone can cook. Even a rat.' },
  { id: 'prisoners', title: 'Prisoners', year: 2013, kind: 'Film', genres: ['Thriller', 'Crime', 'Drama'], runtime: 153, brain: 0.80, intensity: 0.90, levity: 0.05, score: 84, hook: 'How far would you go to find your child?' },
  { id: 'princess-bride', title: 'The Princess Bride', year: 1987, kind: 'Film', genres: ['Adventure', 'Romance', 'Comedy'], runtime: 98, brain: 0.35, intensity: 0.45, levity: 0.90, score: 89, hook: 'As you wish. Also: pirates, giants, revenge.' },
  { id: 'nightcrawler', title: 'Nightcrawler', year: 2014, kind: 'Film', genres: ['Thriller', 'Crime', 'Drama'], runtime: 117, brain: 0.80, intensity: 0.80, levity: 0.20, score: 87, hook: 'If it bleeds, it leads. He films it.' },
  { id: 'inside-out', title: 'Inside Out', year: 2015, kind: 'Film', genres: ['Animation', 'Comedy', 'Drama'], runtime: 95, brain: 0.55, intensity: 0.45, levity: 0.70, score: 92, hook: "The little voices in a girl's head, at war." },
  { id: 'se7en', title: 'Se7en', year: 1995, kind: 'Film', genres: ['Crime', 'Thriller', 'Horror'], runtime: 127, brain: 0.75, intensity: 0.90, levity: 0.05, score: 88, hook: 'Seven deadly sins, one very bad week.' },
  { id: 'amelie', title: 'Amélie', year: 2001, kind: 'Film', genres: ['Romance', 'Comedy'], runtime: 122, brain: 0.55, intensity: 0.30, levity: 0.80, score: 89, hook: "A shy Parisian quietly fixes everyone's life." },
  { id: 'top-gun-maverick', title: 'Top Gun: Maverick', year: 2022, kind: 'Film', genres: ['Action', 'Drama'], runtime: 130, brain: 0.30, intensity: 0.85, levity: 0.50, score: 83, hook: 'The need for speed, thirty years later.' },
  { id: 'hereditary', title: 'Hereditary', year: 2018, kind: 'Film', genres: ['Horror', 'Drama', 'Thriller'], runtime: 127, brain: 0.70, intensity: 0.95, levity: 0.05, score: 80, hook: 'Grief is hereditary. So is something worse.' },
  { id: 'about-time', title: 'About Time', year: 2013, kind: 'Film', genres: ['Romance', 'Comedy', 'Fantasy'], runtime: 123, brain: 0.45, intensity: 0.30, levity: 0.70, score: 80, hook: 'A man can time-travel. He just wants love.' },
  { id: 'zodiac', title: 'Zodiac', year: 2007, kind: 'Film', genres: ['Crime', 'Thriller', 'Drama'], runtime: 157, brain: 0.85, intensity: 0.70, levity: 0.15, score: 84, hook: 'The killer was never caught. The obsession never ended.' },
  { id: 'klaus', title: 'Klaus', year: 2019, kind: 'Film', genres: ['Animation', 'Comedy', 'Adventure'], runtime: 96, brain: 0.35, intensity: 0.35, levity: 0.80, score: 86, hook: 'A selfish postman accidentally invents Santa.' },
  { id: 'ex-machina', title: 'Ex Machina', year: 2014, kind: 'Film', genres: ['Sci-Fi', 'Thriller', 'Drama'], runtime: 108, brain: 0.90, intensity: 0.70, levity: 0.15, score: 86, hook: 'A test of humanity, run by a machine.' },
  { id: 'jojo-rabbit', title: 'Jojo Rabbit', year: 2019, kind: 'Film', genres: ['Comedy', 'Drama'], runtime: 108, brain: 0.60, intensity: 0.50, levity: 0.70, score: 80, hook: 'A lonely boy and his imaginary friend, Adolf.' },
  { id: 'a-quiet-place', title: 'A Quiet Place', year: 2018, kind: 'Film', genres: ['Horror', 'Sci-Fi', 'Thriller'], runtime: 90, brain: 0.50, intensity: 0.90, levity: 0.10, score: 83, hook: "Make a sound and you're dead." },
  { id: 'the-bear', title: 'The Bear', year: 2022, kind: 'Series', genres: ['Drama', 'Comedy'], runtime: 30, brain: 0.70, intensity: 0.85, levity: 0.35, score: 90, hook: 'A fine-dining chef inherits a chaotic sandwich shop.' },
  { id: 'fleabag', title: 'Fleabag', year: 2016, kind: 'Series', genres: ['Comedy', 'Drama'], runtime: 27, brain: 0.70, intensity: 0.50, levity: 0.70, score: 94, hook: 'A woman narrates her own beautiful mess.' },
  { id: 'ted-lasso', title: 'Ted Lasso', year: 2020, kind: 'Series', genres: ['Comedy', 'Drama'], runtime: 34, brain: 0.40, intensity: 0.35, levity: 0.85, score: 87, hook: 'An American coaches British football. Badly, warmly.' },
  { id: 'breaking-bad', title: 'Breaking Bad', year: 2008, kind: 'Series', genres: ['Crime', 'Drama', 'Thriller'], runtime: 47, brain: 0.80, intensity: 0.90, levity: 0.20, score: 96, hook: 'A chemistry teacher cooks up an empire.' },
  { id: 'queens-gambit', title: "The Queen's Gambit", year: 2020, kind: 'Series', genres: ['Drama'], runtime: 55, brain: 0.75, intensity: 0.60, levity: 0.30, score: 88, hook: 'An orphan takes on chess, and her own demons.' },
  { id: 'b99', title: 'Brooklyn Nine-Nine', year: 2013, kind: 'Series', genres: ['Comedy', 'Crime'], runtime: 22, brain: 0.30, intensity: 0.35, levity: 0.90, score: 82, hook: 'The funniest precinct in the NYPD.' },
];

/* Node (tests) + browser (classic script) dual export.
 * Top-level `const` in a classic script is NOT a property of `window`, so we
 * attach explicitly for the browser and use module.exports under Node. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GENRES, MOOD_AXES, CATALOG };
} else {
  const root = typeof window !== 'undefined' ? window : globalThis;
  root.GENRES = GENRES;
  root.MOOD_AXES = MOOD_AXES;
  root.CATALOG = CATALOG;
}
