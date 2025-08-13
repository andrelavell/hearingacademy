#!/usr/bin/env node
import 'dotenv/config';
import path from 'node:path';
import { load } from 'cheerio';
import readingTime from 'reading-time';
import { listArticleFiles, readFile, writeFile } from './utils/fs.js';
import { parseArticleAstro, buildArticleAstro } from './utils/astroArticle.js';
import { verifyReferences } from './utils/verify.js';
import { braveSearchWeb, extractTopResults } from './utils/brave.js';

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ');
}

function findReferencesBlock($) {
  // Locate the first H2 with text 'References' (case-insensitive)
  const h2 = $('h2').filter((_, el) => $(el).text().trim().toLowerCase() === 'references').first();
  if (!h2.length) return null;
  // The references list is expected to be the next UL sibling (or next element that is a UL)
  let ul = h2.nextAll('ul').first();
  if (!ul.length) {
    // Some articles may have links directly after without UL; handle gracefully
    return { h2, ul: null };
  }
  return { h2, ul };
}

function extractRefsFromUl($, ul) {
  const refs = [];
  if (!ul || !ul.length) return refs;
  ul.find('li a[href]').each((_, a) => {
    const $a = $(a);
    const url = ($a.attr('href') || '').trim();
    const label = $a.text().trim();
    if (url && label) refs.push({ label, url });
  });
  return refs;
}

function rebuildReferences($, block, verifiedRefs) {
  const { h2, ul } = block;
  if (!verifiedRefs.length) {
    // Remove entire block (h2 + ul)
    if (ul && ul.length) ul.remove();
    h2.remove();
    return;
  }
  // Ensure we have a UL
  let list = ul;
  if (!list || !list.length) {
    list = $('<ul></ul>');
    h2.after('\n');
    h2.after(list);
  }
  list.empty();
  for (const r of verifiedRefs) {
    const li = $('<li></li>');
    const a = $('<a></a>')
      .attr('href', r.url)
      .attr('rel', 'nofollow noopener')
      .attr('target', '_blank')
      .text(r.label);
    li.append(a);
    list.append(li).append('\n');
  }
}

async function braveBackfill({ title, tags = [] }) {
  if (!process.env.BRAVE_API_KEY) return [];
  try {
    const allowed = new Set(['cdc.gov','nih.gov','nidcd.nih.gov','who.int','mayoclinic.org','asha.org']);
    const tagHint = Array.isArray(tags) ? tags.slice(0, 2).join(' ') : '';
    const siteFilter = 'site:cdc.gov OR site:nih.gov OR site:nidcd.nih.gov OR site:who.int OR site:mayoclinic.org OR site:asha.org';
    const q = `${title} ${tagHint} ${siteFilter}`.trim();
    const res = await braveSearchWeb(q, { count: 10, freshness: 'year', country: 'us', safesearch: 'strict' });
    const top = extractTopResults(res, { max: 10 })
      .filter((r) => {
        try {
          const h = new URL(r.url).hostname.replace(/^www\./,'');
          return Array.from(allowed).some((d) => h === d || h.endsWith('.' + d));
        } catch { return false; }
      })
      .map((r) => ({ label: r.title || r.url, url: r.url }));
    const verified = await verifyReferences(top, { timeoutMs: 6000, max: 6 });
    return verified;
  } catch (e) {
    console.warn('[verify-refs] Brave backfill failed:', e?.message || e);
    return [];
  }
}

async function processFile(filePath) {
  const abs = path.resolve(filePath);
  const content = await readFile(abs, 'utf8');
  const parsed = parseArticleAstro(content);
  if (!parsed) {
    console.error('[verify-refs] Could not parse ArticleLayout from:', abs);
    return false;
  }
  const $ = load(parsed.body || '', { decodeEntities: false });
  let block = findReferencesBlock($);
  let verified = [];
  if (block) {
    const existing = extractRefsFromUl($, block.ul);
    if (existing.length) {
      verified = await verifyReferences(existing, { timeoutMs: 6000, max: 20 });
    }
    if (verified.length === 0) {
      // Try Brave backfill when section exists but is empty
      const backfill = await braveBackfill({ title: parsed.props.title, tags: parsed.props.tags });
      if (backfill.length) verified = backfill;
    }
    rebuildReferences($, block, verified);
  } else {
    // No References section; optionally create one if Brave can find sources
    const backfill = await braveBackfill({ title: parsed.props.title, tags: parsed.props.tags });
    if (backfill.length) {
      // Append new section at end of body
      const bodyEl = $('body');
      const container = bodyEl.length ? bodyEl : $.root();
      const h2 = $('<h2>References</h2>');
      const ul = $('<ul></ul>');
      for (const r of backfill) {
        const li = $('<li></li>');
        const a = $('<a></a>')
          .attr('href', r.url)
          .attr('rel', 'nofollow noopener')
          .attr('target', '_blank')
          .text(r.label);
        li.append(a);
        ul.append(li).append('\n');
      }
      container.append('\n');
      container.append(h2);
      container.append('\n');
      container.append(ul);
      block = { h2, ul };
    } else {
      // Nothing to do
      return false;
    }
  }
  const updatedBody = $.html();
  const reading = readingTime(stripHtml(updatedBody)).text;

  const rebuilt = buildArticleAstro({
    title: parsed.props.title,
    description: parsed.props.description,
    publishedTime: parsed.props.publishedTime,
    modifiedTime: parsed.props.modifiedTime || parsed.props.publishedTime,
    author: parsed.props.author,
    authorTitle: parsed.props.authorTitle,
    category: parsed.props.category,
    tags: parsed.props.tags,
    image: parsed.props.image,
    imageAlt: parsed.props.imageAlt,
    imageCredit: parsed.props.imageCredit,
    imageCreditUrl: parsed.props.imageCreditUrl,
    readingTime: reading,
    body: updatedBody,
  });

  await writeFile(abs, rebuilt);
  console.log('[verify-refs] Updated references in', abs);
  return true;
}

async function main() {
  const arg = process.argv[2];
  let files = [];
  if (arg && arg !== '--all') {
    files = [arg];
  } else {
    files = await listArticleFiles();
  }
  let count = 0;
  for (const f of files) {
    try {
      const changed = await processFile(f);
      if (changed) count++;
    } catch (e) {
      console.error('[verify-refs] Failed', f, e?.message || e);
    }
  }
  console.log(`[verify-refs] Completed. Files updated: ${count}/${files.length}`);
}

main().catch((e) => {
  console.error('[verify-refs] Error:', e);
  process.exit(1);
});
