#!/usr/bin/env node
import 'dotenv/config';
import path from 'node:path';
import { listArticleFiles, readFile, writeJSON, DATA_DIR } from './utils/fs.js';
import { parseArticleAstro } from './utils/astroArticle.js';
import { topicHash } from './utils/dedupe.js';

async function main() {
  const files = await listArticleFiles();
  const items = [];
  for (const fp of files) {
    try {
      const raw = await readFile(fp);
      const parsed = parseArticleAstro(raw);
      if (!parsed || !parsed.props?.title) continue;
      const { props, body, readingTime } = parsed;
      const slug = path.basename(fp, '.astro');
      const rec = {
        slug,
        title: props.title,
        description: props.description || '',
        category: props.category || '',
        tags: Array.isArray(props.tags) ? props.tags : [],
        image: props.image || '',
        publishedTime: props.publishedTime || '',
        modifiedTime: props.modifiedTime || props.publishedTime || '',
        readingTime,
        words: parsed.words,
      };
      rec.hash = topicHash({ title: rec.title, category: rec.category, tags: rec.tags, keywords: [] });
      items.push(rec);
    } catch (e) {
      console.warn('[scan] Failed to parse', fp, e.message);
    }
  }

  const outPath = path.join(DATA_DIR, 'topics_index.json');
  await writeJSON(outPath, items);
  console.log(`[scan] Indexed ${items.length} articles -> ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
