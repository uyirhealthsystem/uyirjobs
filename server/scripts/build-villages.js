// Builds src/domain/villages.json (District → Taluk → revenue villages) for the registration form.
// Source: LGD-derived per-district JSON files (github.com/vedhir555/india_village_data), one
// { taluk: [villages] } file per district, downloaded into a folder:
//   node scripts/build-villages.js <folder-with-district-json-files>
// Taluks come from src/domain/taluks.js (the current district → taluk list); each is matched to
// the source's spelling (e.g. "Walajapet" ↔ "Wallajah"). Unmatched taluks are reported.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TALUKS } from '../src/domain/taluks.js';

const dir = process.argv[2];
if (!dir) { console.error('usage: node scripts/build-villages.js <folder>'); process.exit(1); }

// Source file name → our district name.
const FILE_DISTRICT = { KANCHIPURAM: 'Kancheepuram', NILGIRIS: 'Nilgiris', THIRUVALLUR: 'Tiruvallur', THIRUVARUR: 'Tiruvarur',
  TUTICORIN: 'Thoothukudi', VILLUPURAM: 'Viluppuram' };
// Spellings too different to match automatically: our taluk → source taluk.
const ALIAS = { Walajapet: 'Wallajah', Palacode: 'Palakkodu', Sirkazhi: 'Sirkali', Sankagiri: 'Sankari', Pandalur: 'Panthalur',
  Keelakarai: 'KILAKARAI', Kodavasal: 'Kudavasal', Tirukazhukundram: 'Tirukalukundram', Thandrampattu: 'THANDRAMPET', Madhavaram: 'Mathavaram' };

const norm = s => s.toLowerCase().replace(/[^a-z]/g, '').replace(/h/g, '').replace(/(.)\1+/g, '$1');
function dist(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const title = s => s === s.toUpperCase() ? s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()) : s;

const src = {};   // district → { sourceTaluk: villages }
for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const key = f.replace(/\.json$/, '').toUpperCase();
  const district = FILE_DISTRICT[key] || Object.keys(TALUKS).find(d => d.toUpperCase() === key);
  if (!district) { console.warn('skipped file', f); continue; }
  src[district] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
}

const out = {}, report = [];
for (const [district, taluks] of Object.entries(TALUKS)) {
  out[district] = {};
  for (const taluk of taluks) {
    // Prefer the district's own file; fall back to any file (taluks moved when districts were split).
    const pools = [src[district] || {}, ...Object.entries(src).filter(([d]) => d !== district).map(([, v]) => v)];
    let best = null;
    for (const [i, pool] of pools.entries()) {
      for (const name of Object.keys(pool)) {
        const score = ALIAS[taluk] ? (norm(name) === norm(ALIAS[taluk]) ? 0 : 99) : dist(norm(taluk), norm(name));
        if (score <= 2 && (!best || score < best.score || (score === best.score && i < best.i))) best = { name, score, i, villages: pool[name] };
      }
      if (best && best.i === 0 && best.score === 0) break;
    }
    if (!best) { report.push(`NO MATCH  ${district} / ${taluk}`); out[district][taluk] = []; continue; }
    if (best.score || best.i) report.push(`${best.i ? 'OTHER FILE' : 'fuzzy'.padEnd(10)} ${district} / ${taluk} ← ${best.name}`);
    out[district][taluk] = [...new Set(best.villages.map(v => title(String(v).trim())).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }
}
writeFileSync(new URL('../src/domain/villages.json', import.meta.url), JSON.stringify(out));
console.log(report.join('\n'));
const n = Object.values(out).flatMap(Object.values).reduce((a, v) => a + v.length, 0);
console.log(`\n${n} villages written to src/domain/villages.json`);
