#!/usr/bin/env node
import path from 'node:path';
import { promises as fs } from 'node:fs';
import readingTime from 'reading-time';
import { ARTICLES_DIR, ensureDir } from './utils/fs.js';
import { parseArticleAstro, buildArticleAstro } from './utils/astroArticle.js';

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ');
}

function stripLeadingHeading(html, title) {
  let s = String(html || '').trim();
  // Unwrap full-document wrappers if present
  s = s.replace(/<!DOCTYPE[^>]*>/gi, '');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '');
  s = s.replace(/<html[^>]*>/gi, '');
  s = s.replace(/<\/html>/gi, '');
  s = s.replace(/<body[^>]*>/gi, '');
  s = s.replace(/<\/body>/gi, '');
  // Remove leading <h1>...\n</h1>
  s = s.replace(/^\s*<h1[^>]*>\s*[\s\S]*?<\/h1>\s*/i, '');
  // Remove markdown H1 variants
  s = s.replace(/^\s*#\s+.*\n+/i, '');
  s = s.replace(/^\s*[^\n]+\n=+\n+/i, '');
  // Remove a duplicate first paragraph if it exactly matches the title
  const titleNorm = String(title||'').trim().toLowerCase();
  s = s.replace(/^\s*<p>\s*([^<]+)\s*<\/p>\s*/i, (m, p1) => (String(p1||'').trim().toLowerCase() === titleNorm ? '' : m));
  return s.trim();
}

async function* walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(p);
    } else if (e.isFile() && e.name.endsWith('.astro')) {
      yield p;
    }
  }
}

async function main() {
  await ensureDir(ARTICLES_DIR);
  let changed = 0;
  for await (const file of walk(ARTICLES_DIR)) {
    if (path.basename(file) === 'index.astro') continue;
    const content = await fs.readFile(file, 'utf8');
    const parsed = parseArticleAstro(content);
    if (!parsed) continue;
    const { props, body } = parsed;
    const cleaned = stripLeadingHeading(body, props.title || '');
    if (cleaned === body) continue; // no change

    const stats = readingTime(stripHtml(cleaned));
    const astro = buildArticleAstro({
      title: props.title,
      description: props.description,
      publishedTime: props.publishedTime,
      modifiedTime: new Date().toISOString(),
      author: props.author,
      authorTitle: props.authorTitle,
      category: props.category,
      tags: Array.isArray(props.tags) ? props.tags : [],
      image: props.image,
      imageAlt: props.imageAlt,
      imageCredit: props.imageCredit,
      imageCreditUrl: props.imageCreditUrl,
      readingTime: stats.text,
      body: cleaned,
    });
    await fs.writeFile(file, astro, 'utf8');
    changed++;
    console.log(`[fix] Updated ${file}`);
  }
  console.log(`[fix] Done. Updated ${changed} article(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
