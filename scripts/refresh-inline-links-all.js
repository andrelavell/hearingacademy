#!/usr/bin/env node
import { listArticleFiles, readFile, writeFile, readJSON, DATA_DIR } from './utils/fs.js';
import path from 'node:path';
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

function firstParagraphText(html) {
  const $ = load(String(html || ''), { decodeEntities: false });
  const p = $('p').first().text().trim();
  return p || stripHtml(html).trim();
}

function clampDescription(s, max = 160) {
  const txt = String(s || '').replace(/\s+/g, ' ').trim();
  if (txt.length <= max) return txt;
  const cut = txt.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 80 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:-]+$/, '') + '…';
}

async function processFile(absPath, index) {
  const content = await readFile(absPath, 'utf8');
  // Skip the listing page
  if (path.basename(absPath) === 'index.astro') {
    return { file: absPath, skipped: 'index-page' };
  }
  let parsed = parseArticleAstro(content);
  let props;
  if (!parsed) {
    // Fallback: attempt to recover from malformed attributes
    const currentSlug = path.basename(absPath, '.astro');
    const item = Array.isArray(index) ? index.find((it) => it && (it.slug === currentSlug || (it.url && it.url.endsWith('/' + currentSlug)))) : null;
    const mStart = content.indexOf('<ArticleLayout');
    let body = '';
    if (mStart !== -1) {
      const gtIdx = content.indexOf('>\n', mStart);
      const closeIdx = content.indexOf('</ArticleLayout>');
      if (gtIdx !== -1 && closeIdx !== -1 && closeIdx > gtIdx) {
        body = content.slice(gtIdx + 2, closeIdx).trim();
      } else if (gtIdx !== -1) {
        body = content.slice(gtIdx + 2).trim();
      } else {
        body = content;
      }
    } else {
      body = content;
    }
    parsed = { body };
    props = {
      title: (item && (item.title || item.name)) || 'Article',
      description: '',
      publishedTime: (item && item.publishedTime) || new Date().toISOString(),
      modifiedTime: (item && (item.modifiedTime || item.publishedTime)) || new Date().toISOString(),
      author: (item && item.author) || 'HearingAcademy',
      authorTitle: (item && item.authorTitle) || 'Editorial Team',
      category: (item && item.category) || (Array.isArray(item?.tags) && item.tags[0]) || 'Hearing',
      tags: (item && item.tags) || [],
      image: (item && item.image) || '/images/og-default.jpg',
      imageAlt: (item && item.imageAlt) || ((item && item.title) || 'Article image'),
      imageCredit: (item && item.imageCredit) || '',
      imageCreditUrl: (item && item.imageCreditUrl) || '',
    };
  } else {
    props = parsed.props;
  }
  const currentSlug = path.basename(absPath, '.astro');
  const $ = load(parsed.body || '', { decodeEntities: false });
  // Remove existing internal links (but keep those in Further Reading)
  $('p, li').each((_, el) => {
    const $el = $(el);
    const prevH2 = $el.prevAll('h2').first();
    if (prevH2.length && prevH2.text().trim().toLowerCase() === 'further reading') return;
    $el.find('a[href^="/articles/"]').each((__, a) => {
      const $a = $(a);
      $a.replaceWith($a.text());
    });
  });
  const cleansedBody = $.html();
  const bodySansFR = String(cleansedBody || '').replace(/\n<h2>Further Reading<\/h2>\n[\s\S]*?(?=\n<h2>|$)/i, '\n');

  let updatedBody = injectInlineLinks(
    bodySansFR,
    index,
    { category: props.category, tags: props.tags, title: props.title, slug: currentSlug },
    { maxInline: 4 }
  );

  const related = pickRelated(index, { category: props.category, tags: props.tags }, { limit: 4, excludeSlug: currentSlug });
  if (related.length) updatedBody = appendFurtherReadingToBody(updatedBody, related);

  const reading = readingTime(stripHtml(updatedBody)).text;
  // Always regenerate a safe description from first paragraph to avoid malformed attributes
  const description = clampDescription(firstParagraphText(updatedBody));
  const rebuilt = buildArticleAstro({
    title: props.title,
    description,
    publishedTime: props.publishedTime || new Date().toISOString(),
    modifiedTime: props.modifiedTime || props.publishedTime || new Date().toISOString(),
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

  await writeFile(absPath, rebuilt);
  return { file: absPath, ok: true };
}

async function main() {
  const index = await loadIndex();
  const files = await listArticleFiles();
  let ok = 0, skipped = 0;
  for (const f of files) {
    try {
      const res = await processFile(f, index);
      if (res.ok) ok++; else skipped++;
    } catch (e) {
      skipped++;
      console.error('[refresh-inline-links-all] failed for', f, e?.message || e);
    }
  }
  console.log(`[refresh-inline-links-all] Updated ${ok} files, skipped ${skipped}.`);
}

main().catch((e) => {
  console.error('[refresh-inline-links-all] Fatal:', e);
  process.exit(1);
});
