#!/usr/bin/env node
import path from 'node:path';
import { readFile, writeFile, readJSON, DATA_DIR } from './utils/fs.js';
import { parseArticleAstro, buildArticleAstro } from './utils/astroArticle.js';
import { injectInlineLinks, pickRelated, appendFurtherReadingToBody } from './utils/linking.js';
import { load } from 'cheerio';
import readingTime from 'reading-time';

async function loadIndex() {
  const p = path.join(DATA_DIR, 'topics_index.json');
  const idx = await readJSON(p, []);
  return Array.isArray(idx) ? idx : [];
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ');
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node scripts/refresh-inline-links.js <path-to-article.astro>');
    process.exit(1);
  }
  const abs = path.resolve(filePath);
  const content = await readFile(abs, 'utf8');
  const parsed = parseArticleAstro(content);
  if (!parsed) {
    console.error('Could not parse ArticleLayout from file:', abs);
    process.exit(2);
  }
  const { props } = parsed;
  const currentSlug = path.basename(abs, '.astro');
  // Remove previous internal inline links so we can re-inject with new logic
  const $ = load(parsed.body || '', { decodeEntities: false });
  $('p, li').each((_, el) => {
    const $el = $(el);
    // Preserve links in the "Further Reading" section lists
    const prevH2 = $el.prevAll('h2').first();
    if (prevH2.length && prevH2.text().trim().toLowerCase() === 'further reading') return;
    $el.find('a[href^="/articles/"]').each((__, a) => {
      const $a = $(a);
      $a.replaceWith($a.text());
    });
  });
  const cleansedBody = $.html();
  const index = await loadIndex();

  // Remove any existing "Further Reading" block to regenerate cleanly
  const bodySansFR = String(cleansedBody || '').replace(/\n<h2>Further Reading<\/h2>\n[\s\S]*?(?=\n<h2>|$)/i, '\n');

  // Re-inject inline links with updated logic
  let updatedBody = injectInlineLinks(
    bodySansFR,
    index,
    { category: props.category, tags: props.tags, title: props.title, slug: currentSlug },
    { maxInline: 4 }
  );

  // Rebuild "Further Reading" from current index
  const related = pickRelated(index, { category: props.category, tags: props.tags }, { limit: 4, excludeSlug: currentSlug });
  if (related.length) {
    updatedBody = appendFurtherReadingToBody(updatedBody, related);
  }

  // Recompute reading time (optional, minor differences expected)
  const reading = readingTime(stripHtml(updatedBody)).text;

  const rebuilt = buildArticleAstro({
    title: props.title,
    description: props.description,
    publishedTime: props.publishedTime,
    modifiedTime: props.modifiedTime || props.publishedTime,
    author: props.author,
    authorTitle: props.authorTitle,
    category: props.category,
    tags: props.tags,
    image: props.image,
    imageAlt: props.imageAlt,
    imageCredit: props.imageCredit,
    imageCreditUrl: props.imageCreditUrl,
    readingTime: reading,
    body: updatedBody,
  });

  await writeFile(abs, rebuilt);
  console.log('[refresh-inline-links] Updated anchors in', abs);
}

main().catch((e) => {
  console.error('[refresh-inline-links] Error:', e);
  process.exit(10);
});
