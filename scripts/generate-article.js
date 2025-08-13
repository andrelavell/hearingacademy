#!/usr/bin/env node
import 'dotenv/config';
import path from 'node:path';
import { readFile, writeFile, readJSON, writeJSON, ARTICLES_DIR, DATA_DIR, ensureDir } from './utils/fs.js';
import { parseArticleAstro, buildArticleAstro, makeSlug } from './utils/astroArticle.js';
import { topicHash, jaccard, normalizeTopic } from './utils/dedupe.js';
import { pickRelated, appendFurtherReadingToBody } from './utils/linking.js';
import { findHeroImage } from './utils/pexels.js';
import { openai, OPENAI_MODEL, generateJSON } from './utils/openai.js';
import { loadCategories, loadTags, envInt, loadAuthors } from './utils/config.js';
import { downloadToPublic } from './utils/images.js';
import readingTime from 'reading-time';

const TODAY_ISO = new Date().toISOString();

async function loadIndex() {
  const p = path.join(DATA_DIR, 'topics_index.json');
  return (await readJSON(p, [])) || [];
}

async function saveIndex(items) {
  const p = path.join(DATA_DIR, 'topics_index.json');
  await writeJSON(p, items);
}

function computeReadingTime(bodyHtml) {
  const text = String(bodyHtml || '').replace(/<[^>]+>/g, ' ');
  return readingTime(text).text;
}

function pickTopic(categories) {
  // Simple rotation/random seed; could be replaced by smarter planner.
  const idx = Math.floor(Math.random() * categories.length);
  return categories[idx] || 'Hearing Loss';
}

function draftSystemPrompt() {
  const tone = process.env.TONE || 'human, empathetic, fun, highly-educational';
  const minWords = envInt('MIN_WORDS', 1000);
  const maxWords = envInt('MAX_WORDS', 1500);
  return [
    `You are a senior health writer for HearingAcademy. Write with a ${tone} tone.`,
    'Audience: adults seeking practical, trustworthy hearing health guidance.',
    'Goals: extreme value, easy to read, engaging psychological hooks, clear structure, evidence-based.',
    `Length: ${minWords}-${maxWords} words.`,
    'Structure: H1 (title), lede/snippet, well-structured H2/H3 sections, bullet lists, short paragraphs, FAQ (2-4 Q&As), and optional References with reputable sources (CDC, WHO, NIH, Mayo Clinic).',
    'Avoid medical diagnosis; include gentle CTAs to consult audiologists when relevant.',
    'Return ONLY JSON matching the provided schema, no markdown fences.'
  ].join(' ');
}

function draftUserPrompt({ category, existingTitles, tagPool }) {
  // Provide context for dedupe and internal linking
  const hints = [
    `Category: ${category}`,
    `Existing titles to avoid duplicating (themes/angles): ${existingTitles.slice(0, 25).join('; ')}`,
    `Preferred tags (choose 4-7 relevant): ${tagPool.slice(0, 50).join(', ')}`,
  ].join('\n');

  const schema = {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      category: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      keywords: { type: 'array', items: { type: 'string' } },
      image_query: { type: 'string' },
      body_html: { type: 'string' },
      faqs: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' } }, required: ['q','a'] } },
      references: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } }, required: ['label','url'] } }
    },
    required: ['title','description','category','tags','keywords','image_query','body_html']
  };

  const instructions = [
    'Propose a unique angle within the category (no duplicates with existing titles/themes).',
    'Return JSON with fields: title, description, category, tags, keywords, image_query, body_html, faqs, references.'
  ].join(' ');

  return `${hints}\n\n${instructions}\n\nJSON schema (for reference, do not include): ${JSON.stringify(schema)}`;
}

function isDuplicate(candidate, index) {
  const candHash = topicHash(candidate);
  if (index.some((it) => it.hash === candHash)) return true;
  const titleSim = index.map((it) => ({ slug: it.slug, s: jaccard([candidate.title], [it.title]) }));
  const near = titleSim.find((x) => x.s >= 0.9);
  return Boolean(near);
}

function renderFaqAndRefs(faqs = [], refs = []) {
  let out = '';
  if (faqs.length) {
    out += `\n\n<h2>Frequently Asked Questions</h2>\n`;
    for (const f of faqs) {
      out += `\n<h3>${escapeHtml(f.q)}</h3>\n<p>${f.a}</p>\n`;
    }
  }
  if (refs.length) {
    out += `\n\n<h2>References</h2>\n<ul>\n`;
    for (const r of refs) {
      out += `<li><a href="${r.url}" rel="nofollow noopener" target="_blank">${escapeHtml(r.label)}</a></li>\n`;
    }
    out += `</ul>\n`;
  }
  return out;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function main() {
  const categories = await loadCategories();
  const tags = await loadTags();
  const authors = await loadAuthors();
  const index = await loadIndex();

  // Pick a category; allow override via CLI arg
  const argCategory = process.argv[2];
  const category = argCategory && categories.includes(argCategory) ? argCategory : pickTopic(categories);

  const system = draftSystemPrompt();
  const user = draftUserPrompt({
    category,
    existingTitles: index.map((i) => i.title),
    tagPool: tags,
  });

  const result = await generateJSON({ system, user });
  const data = {
    title: (result.title || '').trim(),
    description: (result.description || '').trim(),
    category: (result.category || category).trim() || category,
    tags: Array.isArray(result.tags) ? result.tags.slice(0, 7) : [],
    keywords: Array.isArray(result.keywords) ? result.keywords.slice(0, 10) : [],
    image_query: (result.image_query || `${category} hearing`).trim(),
    body_html: String(result.body_html || ''),
    faqs: Array.isArray(result.faqs) ? result.faqs : [],
    references: Array.isArray(result.references) ? result.references : [],
  };

  if (!data.title || !data.body_html) {
    throw new Error('Model returned incomplete article.');
  }

  const candidate = {
    title: data.title,
    category: data.category,
    tags: data.tags,
    keywords: data.keywords,
  };

  if (isDuplicate(candidate, index)) {
    console.error('[generate] Duplicate detected, aborting. Try again.');
    process.exit(2);
  }

  // Find related existing articles
  const related = pickRelated(index, { category: data.category, tags: data.tags }, { limit: 4 });
  let body = data.body_html;
  if (related.length) body = appendFurtherReadingToBody(body, related);
  body += renderFaqAndRefs(data.faqs, data.references);

  // Compute slug early (used for image naming)
  const slug = makeSlug(data.title);

  // Fetch hero image and optionally download locally
  const hero = await findHeroImage({
    query: data.image_query,
    category: data.category,
    tags: data.tags,
    keywords: data.keywords,
  });
  const storage = String(process.env.IMAGE_STORAGE || 'local').toLowerCase();
  let imageSrc = hero?.src || '/article-default.jpg';
  let imageAlt = hero?.alt || data.title;
  let imageCredit = hero?.credit || '';
  let imageCreditUrl = hero?.credit_url || '';
  if (hero && storage === 'local') {
    try {
      const dl = await downloadToPublic(imageSrc, slug, hero.id || 'img');
      imageSrc = dl.publicPath;
    } catch (e) {
      console.warn('[image] download failed, using remote URL:', e.message);
    }
  }
  const reading = computeReadingTime(body);

  // Pick a random author (fallback to env or default)
  const pickAuthor = () => {
    if (Array.isArray(authors) && authors.length) {
      const a = authors[Math.floor(Math.random() * authors.length)];
      return { name: a.name || 'HearingAcademy Editorial', title: a.title || 'Audiologist & Hearing Specialist' };
    }
    return { name: process.env.AUTHOR_NAME || 'HearingAcademy Editorial', title: 'Audiologist & Hearing Specialist' };
  };
  const authorInfo = pickAuthor();

  const astro = buildArticleAstro({
    title: data.title,
    description: data.description,
    publishedTime: TODAY_ISO,
    modifiedTime: TODAY_ISO,
    author: authorInfo.name,
    authorTitle: authorInfo.title,
    category: data.category,
    tags: data.tags,
    image: imageSrc,
    imageAlt,
    imageCredit,
    imageCreditUrl,
    readingTime: reading,
    body,
  });

  await ensureDir(ARTICLES_DIR);
  const outPath = path.join(ARTICLES_DIR, `${slug}.astro`);
  await writeFile(outPath, astro);
  console.log(`[generate] Wrote article: ${outPath}`);

  // Update index
  const newRec = {
    slug,
    title: data.title,
    description: data.description,
    category: data.category,
    tags: data.tags,
    image: imageSrc,
    publishedTime: TODAY_ISO,
    modifiedTime: TODAY_ISO,
    readingTime: reading,
  };
  newRec.hash = topicHash({ title: newRec.title, category: newRec.category, tags: newRec.tags, keywords: data.keywords });
  index.unshift(newRec);
  await saveIndex(index);

  console.log(`[generate] Index updated. Model=${OPENAI_MODEL}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
