#!/usr/bin/env node
import 'dotenv/config';
import path from 'node:path';
import { listArticleFiles, readFile, writeFile } from './utils/fs.js';
import { parseArticleAstro, buildArticleAstro } from './utils/astroArticle.js';
import { findHeroImage as findUnsplash } from './utils/unsplash.js';
import { findHeroImage as findPexels } from './utils/pexels.js';
import { loadUsedImages, registerUsedImage, downloadToPublic } from './utils/images.js';

async function updateOne(filePath, opts) {
  const rel = path.relative(process.cwd(), filePath);
  const content = await readFile(filePath);
  const parsed = parseArticleAstro(content);
  if (!parsed || !parsed.props) {
    console.warn(`[refresh] Skip unparsable: ${rel}`);
    return { file: rel, skipped: true };
  }
  const p = parsed.props;
  const title = String(p.title || '').trim();
  const category = String(p.category || '').trim();
  const tags = Array.isArray(p.tags) ? p.tags : [];
  const keywords = title.split(/[^a-z0-9]+/i).filter(Boolean).slice(0, 6);

  const used = await loadUsedImages();
  const usedUnsplash = used.filter(r => String(r.provider).toLowerCase()==='unsplash').map(r=>String(r.id));
  const usedPexels = used.filter(r => String(r.provider).toLowerCase()==='pexels').map(r=>String(r.id));

  let hero = null;
  try { hero = await findUnsplash({ query: title, category, tags, keywords, excludeIds: usedUnsplash }); } catch {}
  if (!hero) {
    try { hero = await findPexels({ query: title, category, tags, keywords, excludeIds: usedPexels }); } catch {}
  }
  if (!hero) {
    console.warn(`[refresh] No relevant image found for: ${rel}`);
    return { file: rel, updated: false };
  }

  // Download and register
  const slugFromPath = path.basename(filePath, '.astro');
  const dl = await downloadToPublic(hero.src, slugFromPath, hero.id, hero.provider || 'unsplash');
  await registerUsedImage({
    provider: hero.provider || 'unknown',
    id: hero.id || '',
    slug: slugFromPath,
    src: dl.publicPath,
    credit: hero.credit || '',
    credit_url: hero.credit_url || '',
    original_url: hero.original_url || hero.src || ''
  });

  // Rebuild file with updated image props
  const next = buildArticleAstro({
    title: p.title || '',
    description: p.description || '',
    publishedTime: p.publishedTime || '',
    modifiedTime: new Date().toISOString(),
    author: p.author || '',
    authorTitle: p.authorTitle || '',
    category: p.category || '',
    tags: Array.isArray(p.tags) ? p.tags : [],
    image: dl.publicPath,
    imageAlt: p.imageAlt || p.title || '',
    imageCredit: hero.credit || '',
    imageCreditUrl: hero.credit_url || '',
    readingTime: p.readingTime || parsed.readingTime || '',
    body: parsed.body || ''
  });

  if (!opts?.dryRun) {
    await writeFile(filePath, next);
  }
  return { file: rel, updated: true, provider: hero.provider, id: hero.id, image: dl.publicPath };
}

async function main() {
  const files = await listArticleFiles();
  console.log(`[refresh] Found ${files.length} articles`);
  const results = [];
  for (const f of files) {
    try {
      const r = await updateOne(f, { dryRun: false });
      results.push(r);
      if (r.updated) console.log(`[refresh] Updated: ${r.file} -> ${r.image} (${r.provider}:${r.id})`);
    } catch (e) {
      console.warn(`[refresh] Error processing ${f}:`, e?.message || e);
    }
  }
  const updated = results.filter(r => r && r.updated).length;
  const skipped = results.filter(r => r && r.skipped).length;
  console.log(`[refresh] Done. Updated ${updated}, skipped ${skipped}, total ${results.length}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
