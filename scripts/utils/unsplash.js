import 'dotenv/config';

const key = process.env.UNSPLASH_ACCESS_KEY;
let hasKey = !!key;
if (!hasKey) {
  console.warn('[Unsplash] Missing UNSPLASH_ACCESS_KEY in environment. Unsplash search will be skipped.');
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
  const text = [photo.alt_description, photo.description, photo.slug, photo.user?.name, photo.tags?.map(t => t.title).join(' ')]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  let score = 0;
  for (const w of POSITIVE) if (text.includes(w)) score += 5;
  const negatives = new Set(NEGATIVE_BASE);
  // allow pediatric content when explicitly pediatric
  const isPediatric = (opts?.contextTerms || []).some((t) => /pediatric|child|children|kids|kid|baby/.test(String(t)));
  if (isPediatric) {
    ['baby','child','toddler'].forEach((w) => negatives.delete(w));
  }
  for (const w of negatives) if (text.includes(w)) score -= 8;
  for (const w of (weights || [])) if (text.includes(w)) score += 2;
  if ((photo.width || 0) >= (photo.height || 0)) score += 1; // prefer landscape
  return score;
}

async function searchOnce(q) {
  const url = new URL('https://api.unsplash.com/search/photos');
  url.searchParams.set('query', q);
  url.searchParams.set('per_page', '30');
  url.searchParams.set('orientation', 'landscape');
  url.searchParams.set('content_filter', 'high');
  const res = await fetch(url, {
    headers: { Authorization: `Client-ID ${key}` }
  });
  if (!res.ok) throw new Error(`Unsplash API ${res.status}`);
  const json = await res.json();
  return Array.isArray(json?.results) ? json.results : [];
}

export async function findHeroImage(input) {
  if (!hasKey) return null;
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
    const seen = new Set();
    const merged = [];
    for (const p of all) {
      const id = String(p.id);
      if (seen.has(id)) continue;
      seen.add(id);
      if (excludeIds.has(id)) continue;
      merged.push(p);
    }
    if (!merged.length) return null;

    const weightTerms = [kebab(category), ...tags.map(kebab), ...keywords.map(kebab)].filter(Boolean);
    const contextTerms = [category, ...tags, ...keywords].map((s)=>String(s||'').toLowerCase());
    // Hard filter: require core terms if strict
    const strict = String(process.env.IMAGE_STRICT_RELEVANCE || 'true').toLowerCase() === 'true';
    const withCore = merged.filter((p) => {
      const text = [p.alt_description, p.description, p.slug, p.user?.name, (p.tags||[]).map(t=>t.title).join(' ')]
        .filter(Boolean).join(' ').toLowerCase();
      return CORE_TERMS.some((t) => text.includes(t));
    });
    const candidates = withCore.length ? withCore : (strict ? [] : merged);
    if (!candidates.length) return null;
    let best = candidates[0];
    let bestScore = -Infinity;
    for (const p of candidates) {
      const s = scorePhoto(p, weightTerms, { contextTerms });
      if (s > bestScore) { best = p; bestScore = s; }
    }
    // Minimum relevance threshold in strict mode
    const minScore = strict ? 2 : -Infinity;
    if (bestScore < minScore) return null;
    return {
      provider: 'unsplash',
      src: best.urls?.full || best.urls?.regular || best.urls?.raw,
      alt: best.alt_description || core || 'hearing health',
      credit: best.user?.name || 'Unsplash Creator',
      credit_url: best.user?.links?.html || best.links?.html,
      unsplash_url: best.links?.html,
      id: best.id,
      original_url: best.links?.download_location || best.links?.html,
    };
  } catch (e) {
    console.warn('[Unsplash] search failed:', e.message);
    return null;
  }
}
