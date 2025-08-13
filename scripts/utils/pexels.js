import 'dotenv/config';
import { createClient } from 'pexels';

const key = process.env.PEXELS_API_KEY;
let client = null;
if (!key) {
  console.warn('[Pexels] Missing PEXELS_API_KEY in environment. Image selection will be skipped.');
} else {
  client = createClient(key);
}

export async function findHeroImage(query) {
  if (!client) return null;
  const q = String(query || '').trim() || 'hearing health';
  try {
    const res = await client.photos.search({ query: q, per_page: 20, orientation: 'landscape', size: 'large' });
    const photos = res?.photos || [];
    if (photos.length === 0) return null;
    const pick = photos[0];
    return {
      src: pick.src?.large2x || pick.src?.large || pick.src?.original,
      alt: pick.alt || q,
      credit: pick.photographer,
      credit_url: pick.photographer_url,
      pexels_url: pick.url,
      id: pick.id,
    };
  } catch (e) {
    console.warn('[Pexels] search failed:', e.message);
    return null;
  }
}
