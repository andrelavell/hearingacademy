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
  'hearing', 'hearing aid', 'hearing aids', 'ear', 'audiology', 'audiologist', 'cochlear', 'tinnitus', 'earplug', 'hearing test', 'clinic', 'audiogram', 'real ear', 'otology', 'oticon', 'phonak', 'resound'
];
const NEGATIVE_BASE = [
  'headphones', 'earbuds', 'music', 'concert', 'speaker', 'dj', 'microphone', 'studio', 'headset',
  'thermometer', 'fever', 'temperature', 'covid', 'stethoscope', 'baby', 'child', 'toddler',
  // off-topic lifestyle/fashion
  'jewelry', 'earring', 'earrings', 'piercing', 'pierced', 'hairstyle', 'haircut', 'salon', 'barber', 'barbershop', 'makeup', 'fashion', 'accessory'
];
const CORE_TERMS = ['hearing','hearing aid','hearing aids','ear','audiology','audiologist','audiogram','tinnitus','otology','cochlear'];

function kebab(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function scorePhoto(photo, weights, opts = {}) {
  const text = [photo.alt, photo.url, photo.photographer, photo.photographer_url]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  let score = 0;
  for (const w of POSITIVE) if (text.includes(w)) score += 5;
  const negatives = new Set(NEGATIVE_BASE);
  const isPediatric = (opts?.contextTerms || []).some((t) => /pediatric|child|children|kids|kid|baby/.test(String(t)));
  if (isPediatric) {
    ['baby','child','toddler'].forEach((w) => negatives.delete(w));
  }
  for (const w of negatives) if (text.includes(w)) score -= 8;
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
  const excludeIds = new Set((isObj && Array.isArray(input.excludeIds) ? input.excludeIds : []).map(String));

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
    // Dedupe by id and exclude already-used ids
    const map = new Map();
    for (const p of all) map.set(String(p.id), p);
    const merged = Array.from(map.entries())
      .filter(([id]) => !excludeIds.has(String(id)))
      .map(([, p]) => p);
    const weightTerms = [kebab(category), ...tags.map(kebab), ...keywords.map(kebab)].filter(Boolean);
    const contextTerms = [category, ...tags, ...keywords].map((s)=>String(s||'').toLowerCase());
    // Hard filter: require core terms if strict
    const strict = String(process.env.IMAGE_STRICT_RELEVANCE || 'true').toLowerCase() === 'true';
    const withCore = merged.filter((p) => {
      const text = [p.alt, p.url, p.photographer, p.photographer_url]
        .filter(Boolean).join(' ').toLowerCase();
      return CORE_TERMS.some((t) => text.includes(t));
    });
    const candidates = withCore.length ? withCore : (strict ? [] : merged);
    if (!candidates.length) return null;
    let best = candidates[0];
    let bestScore = -Infinity;
    for (const p of candidates) {
      const s = scorePhoto(p, weightTerms, { contextTerms });
      if (s > bestScore) {
        best = p; bestScore = s;
      }
    }
    // Enforce minimal relevance in strict mode
    const minScore = strict ? 2 : -Infinity;
    if (bestScore < minScore) return null;
    return {
      provider: 'pexels',
      src: best.src?.large2x || best.src?.large || best.src?.original,
      alt: best.alt || core || 'hearing health',
      credit: best.photographer,
      credit_url: best.photographer_url,
      pexels_url: best.url,
      original_url: best.src?.original || best.url,
      id: best.id,
    };
  } catch (e) {
    console.warn('[Pexels] search failed:', e.message);
    return null;
  }
}
