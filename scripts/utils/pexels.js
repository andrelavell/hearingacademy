import 'dotenv/config';
import { createClient } from 'pexels';

const key = process.env.PEXELS_API_KEY;
let client = null;
if (!key) {
  console.warn('[Pexels] Missing PEXELS_API_KEY in environment. Image selection will be skipped.');
} else {
  client = createClient(key);
}

const POSITIVE = [
  'hearing', 'hearing aid', 'hearing aids', 'ear', 'audiology', 'audiologist', 'cochlear', 'tinnitus', 'earplug', 'hearing test', 'clinic'
];
const NEGATIVE = [
  'headphones', 'earbuds', 'music', 'concert', 'speaker', 'dj', 'microphone', 'studio', 'headset'
];

function kebab(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function scorePhoto(photo, weights) {
  const text = [photo.alt, photo.url, photo.photographer, photo.photographer_url]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  let score = 0;
  for (const w of POSITIVE) if (text.includes(w)) score += 5;
  for (const w of NEGATIVE) if (text.includes(w)) score -= 6;
  for (const w of (weights || [])) if (text.includes(w)) score += 2;
  // Prefer landscape large assets
  if (photo.width >= photo.height) score += 1;
  return score;
}

async function searchOnce(q) {
  const res = await client.photos.search({ query: q, per_page: 30, orientation: 'landscape', size: 'large' });
  return res?.photos || [];
}

export async function findHeroImage(input) {
  if (!client) return null;
  const isObj = input && typeof input === 'object' && !Array.isArray(input);
  const baseQuery = String((isObj ? input.query : input) || '').trim();
  const category = isObj ? String(input.category || '') : '';
  const tags = isObj ? (Array.isArray(input.tags) ? input.tags : []) : [];
  const keywords = isObj ? (Array.isArray(input.keywords) ? input.keywords : []) : [];

  const core = baseQuery || [category, 'hearing'].filter(Boolean).join(' ');
  const tagStr = tags.slice(0, 3).join(' ');
  const kwStr = keywords.slice(0, 3).join(' ');

  const queries = [
    core,
    `${category} hearing aid`,
    `${core} ${tagStr}`.trim(),
    `${core} ${kwStr}`.trim(),
    'hearing aid',
    'audiology clinic',
    'ear closeup'
  ].filter((v, i, arr) => v && arr.indexOf(v) === i);

  try {
    const all = [];
    for (const q of queries) {
      const photos = await searchOnce(q);
      for (const p of photos) all.push(p);
      if (all.length >= 50) break;
    }
    if (!all.length) return null;
    // Dedupe by id
    const map = new Map();
    for (const p of all) map.set(p.id, p);
    const merged = Array.from(map.values());
    const weightTerms = [kebab(category), ...tags.map(kebab), ...keywords.map(kebab)].filter(Boolean);
    let best = merged[0];
    let bestScore = -Infinity;
    for (const p of merged) {
      const s = scorePhoto(p, weightTerms);
      if (s > bestScore) {
        best = p; bestScore = s;
      }
    }
    return {
      src: best.src?.large2x || best.src?.large || best.src?.original,
      alt: best.alt || core || 'hearing health',
      credit: best.photographer,
      credit_url: best.photographer_url,
      pexels_url: best.url,
      id: best.id,
    };
  } catch (e) {
    console.warn('[Pexels] search failed:', e.message);
    return null;
  }
}
