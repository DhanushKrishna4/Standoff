/* =============================================================================
 * scripts/enrich-catalog.mjs — refresh catalog.js IN PLACE with the deepened
 * dimensions (learned tone axes, novelty, rating, warnings) the engine now uses,
 * without a TMDB rebuild. Reads the current catalog, runs the same pure enrich
 * pass the rebuild uses, and writes catalog.js back.
 *
 *   node scripts/enrich-catalog.mjs
 * ========================================================================== */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { enrichCatalog } from './enrich.mjs';
import { serialize } from './build-catalog.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { CATALOG } = require(join(here, '..', 'catalog.js'));

const enriched = enrichCatalog(CATALOG);
writeFileSync(join(here, '..', 'catalog.js'), serialize(enriched));

const sample = enriched[0];
console.log(`Enriched ${enriched.length} titles → catalog.js`);
console.log('Sample:', JSON.stringify({
  title: sample.title, pace: sample.pace, darkness: sample.darkness,
  dialogue: sample.dialogue, novelty: sample.novelty,
  certification: sample.certification, warnings: sample.warnings,
}));
