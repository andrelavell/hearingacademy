#!/usr/bin/env node
import 'dotenv/config';
import { findHeroImage as findUnsplash } from './utils/unsplash.js';
import { findHeroImage as findPexels } from './utils/pexels.js';
import { loadUsedImages, registerUsedImage, downloadToPublic } from './utils/images.js';

async function main() {
  const used = await loadUsedImages();
  const usedUnsplash = used.filter(r => String(r.provider).toLowerCase() === 'unsplash').map(r => String(r.id));
  const usedPexels = used.filter(r => String(r.provider).toLowerCase() === 'pexels').map(r => String(r.id));

  const input = {
    query: 'hearing aids clinic',
    category: 'Hearing Health',
    tags: ['hearing aids', 'clinic'],
    keywords: ['hearing', 'audiology']
  };

  let hero = null;
  try { hero = await findUnsplash({ ...input, excludeIds: usedUnsplash }); } catch {}
  if (!hero) {
    try { hero = await findPexels({ ...input, excludeIds: usedPexels }); } catch {}
  }
  if (!hero) {
    console.error('[test] No image found from Unsplash or Pexels.');
    process.exit(2);
  }

  const slug = 'test-image';
  const dl = await downloadToPublic(hero.src, slug, hero.id, hero.provider || 'unsplash');
  await registerUsedImage({
    provider: hero.provider || 'unsplash',
    id: hero.id,
    slug,
    src: dl.publicPath,
    credit: hero.credit,
    credit_url: hero.credit_url,
    original_url: hero.original_url || hero.src
  });

  const out = { provider: hero.provider, id: hero.id, saved: dl.publicPath, credit: hero.credit };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
