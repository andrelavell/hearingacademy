import type { APIRoute } from 'astro';
import path from 'node:path';
import fs from 'node:fs/promises';
import matter from 'gray-matter';
import { marked } from 'marked';
import readingTime from 'reading-time';
import sharp from 'sharp';

// Reuse project utilities
import { ARTICLES_DIR, DATA_DIR, ensureDir, readJSON, writeJSON, writeFile } from '../../../scripts/utils/fs.js';
import { buildArticleAstro, makeSlug, makeCompactSlug } from '../../../scripts/utils/astroArticle.js';
import { loadCategories, loadAuthors } from '../../../scripts/utils/config.js';
import { loadUsedImages, registerUsedImage, downloadToPublic } from '../../../scripts/utils/images.js';
import { findHeroImage } from '../../../scripts/utils/unsplash.js';
import { topicHash } from '../../../scripts/utils/dedupe.js';

export const prerender = false;

const FALLBACK_IMG = '/images/articles/2025-08/ai-hearing-aids-noise-pexels-14682242.jpg';

// --- GitHub commit helpers (for Netlify serverless) ---
async function githubCommitFiles(filePaths: string[], message: string): Promise<{ ok: boolean; details?: any }> {
  try {
    const token = String(process.env.GITHUB_TOKEN || '').trim();
    const repo = String(process.env.GITHUB_REPO || '').trim(); // format: owner/name
    const branch = String(process.env.GITHUB_BRANCH || 'main').trim();
    if (!token || !repo) return { ok: false, details: 'Missing GITHUB_TOKEN or GITHUB_REPO' };

    const [owner, name] = repo.split('/');
    if (!owner || !name) return { ok: false, details: 'GITHUB_REPO must be owner/name' };

    const root = process.cwd();

    const putFile = async (absPath: string) => {
      // Compute repo-relative path
      let rel = absPath.startsWith(root) ? absPath.slice(root.length) : absPath;
      if (rel.startsWith(path.sep)) rel = rel.slice(1);

      // Read file content (binary-safe)
      const buf = await fs.readFile(absPath);
      const contentB64 = buf.toString('base64');

      // Get existing SHA if file exists
      const getUrl = `https://api.github.com/repos/${owner}/${name}/contents/${encodeURIComponent(rel)}?ref=${encodeURIComponent(branch)}`;
      let sha: string | undefined;
      try {
        const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'HearingAcademy-Uploader' } });
        if (getRes.ok) {
          const j: any = await getRes.json();
          if (j && j.sha) sha = j.sha;
        }
      } catch {}

      const putUrl = `https://api.github.com/repos/${owner}/${name}/contents/${encodeURIComponent(rel)}`;
      const body = {
        message,
        content: contentB64,
        branch,
        sha,
      } as any;
      const res = await fetch(putUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'HearingAcademy-Uploader',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`GitHub PUT failed for ${rel}: ${res.status} ${txt}`);
      }
    };

    for (const fp of filePaths) {
      try {
        await putFile(fp);
      } catch (e: any) {
        console.warn('[upload] github commit failed for', fp, e?.message || e);
        throw e;
      }
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, details: e?.message || String(e) };
  }
}

function stripHtml(html: string): string {
  return String(html || '').replace(/<[^>]+>/g, ' ');
}

async function compressImage(filePath: string): Promise<void> {
  try {
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    const img = sharp(filePath, { failOn: 'none' });
    // Choose encoder based on extension, keep same extension to avoid path changes
    if (ext === 'jpg' || ext === 'jpeg') {
      await img.jpeg({ quality: 82, mozjpeg: true }).toFile(filePath + '.tmp');
    } else if (ext === 'png') {
      await img.png({ compressionLevel: 9, adaptiveFiltering: true, palette: true }).toFile(filePath + '.tmp');
    } else if (ext === 'webp') {
      await img.webp({ quality: 82, effort: 4 }).toFile(filePath + '.tmp');
    } else if (ext === 'avif') {
      await img.avif({ quality: 50, effort: 4 }).toFile(filePath + '.tmp');
    } else {
      // default to jpeg re-encode if unknown
      await img.jpeg({ quality: 82, mozjpeg: true }).toFile(filePath + '.tmp');
    }
    await fs.rename(filePath + '.tmp', filePath);
  } catch (e) {
    console.warn('[upload] image compression skipped:', (e as any)?.message || e);
  }
}

function suggestAlt({ title, category, tags, filename }: { title: string; category: string; tags: string[]; filename?: string }): string {
  const base = title?.trim();
  if (base) return base;
  const name = (filename || '').replace(/[-_]/g, ' ').replace(/\.[a-z0-9]{2,4}$/i, '');
  const parts = [name, category, (tags && tags[0]) || ''].map((s) => String(s || '').trim()).filter(Boolean);
  return parts[0] || 'Article hero image';
}

function stripLeadingH1(html: string, title?: string): string {
  const s = String(html || '');
  // remove very first <h1>...</h1>
  return s.replace(/^[\s\S]*?<h1[^>]*>[\s\S]*?<\/h1>\s*/i, (m) => {
    // keep content after the first H1 only
    return '';
  });
}

function inferTitleFromMd(md: string): string | null {
  const m = String(md || '').match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

function summarizeDescriptionFromHtml(html: string, maxLen = 160): string {
  const text = stripHtml(html).replace(/\s+/g, ' ').trim();
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 50 ? cut.slice(0, lastSpace) : cut).trim() + '…';
}

async function ensureUniqueSlug(baseSlug: string, index: any[]): Promise<string> {
  let slug = baseSlug;
  if (!index.some((it) => it.slug === slug)) return slug;
  let i = 2;
  while (index.some((it) => it.slug === `${slug}-${i}`)) i++;
  return `${slug}-${i}`;
}

async function saveUploadedImage(file: File, slug: string): Promise<{ publicPath: string; filePath: string; filename: string }> {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dir = path.join(process.cwd(), 'public', 'images', 'articles', ym);
  await fs.mkdir(dir, { recursive: true });
  const name = file.name || 'upload';
  const extMatch = name.match(/\.([a-zA-Z0-9]{3,4})$/);
  const extFromType = (file.type || '').split('/').pop() || '';
  const ext = (extMatch ? extMatch[1].toLowerCase() : (extFromType || 'jpg'));
  const safeExt = ['jpg','jpeg','png','webp','avif'].includes(ext) ? ext : 'jpg';
  const filename = `${slug}-upload-${Date.now()}.${safeExt}`;
  const target = path.join(dir, filename);
  const buf = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(target, buf);
  await compressImage(target);
  const publicPath = `/images/articles/${ym}/${filename}`;
  return { publicPath, filePath: target, filename };
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const form = await request.formData();
    const mdFile = form.get('mdfile');
    if (!(mdFile instanceof File)) {
      return new Response(JSON.stringify({ error: 'Missing Markdown file (mdfile).' }), { status: 400 });
    }

    const providedTitle = String(form.get('title') || '').trim();
    const providedDesc = String(form.get('description') || '').trim();
    const providedCategory = String(form.get('category') || '').trim();
    const tagsStr = String(form.get('tags') || '').trim();
    const imageMode = String(form.get('imageMode') || 'auto');
    const imageQuery = String(form.get('imageQuery') || '').trim();
    const imageUrl = String(form.get('imageUrl') || '').trim();
    const imageUpload = form.get('imageUpload');
    const providedSlugRaw = String(form.get('slug') || '').trim();

    // Parse markdown and optional frontmatter
    const mdText = await mdFile.text();
    const fm = matter(mdText);

    // Compute title
    const title = providedTitle || String(fm.data.title || inferTitleFromMd(fm.content) || 'Untitled').trim();

    // Compute HTML body
    const rawHtml = marked.parse(fm.content);
    const bodyHtml = stripLeadingH1(String(rawHtml), title);

    // Compute description
    const description = providedDesc || String(fm.data.description || summarizeDescriptionFromHtml(bodyHtml));

    // Category & tags
    const categories = await loadCategories();
    const category = providedCategory || String(fm.data.category || categories[0] || 'Hearing Health');
    const tags = (() => {
      const fromForm = tagsStr ? tagsStr.split(',').map((s) => s.trim()).filter(Boolean) : [];
      const fromFm = Array.isArray(fm.data.tags) ? fm.data.tags.map((s: any) => String(s)) : [];
      const merged = [...fromForm, ...fromFm];
      const uniq: string[] = [];
      for (const t of merged) {
        const tt = t.trim();
        if (tt && !uniq.includes(tt)) uniq.push(tt);
      }
      return uniq.slice(0, 10);
    })();

    // Prepare index and slug
    const indexPath = path.join(DATA_DIR, 'topics_index.json');
    const index = (await readJSON(indexPath, null)) || [];

    // Determine base slug
    // If user provided a slug, sanitize using makeSlug; else prefer compact slug (~60 chars, <=6 words)
    let baseSlug: string;
    if (providedSlugRaw) {
      baseSlug = makeSlug(providedSlugRaw);
    } else {
      const kw: string[] = Array.isArray(tags) ? tags.map((t: any) => String(t)) : [];
      const compact = (makeCompactSlug as any)({ title, keywords: kw, maxLen: 60, maxWords: 6 });
      const fallback = makeSlug(title);
      baseSlug = compact || fallback;
    }
    // Hard cap length in case of extreme cases
    if (baseSlug.length > 60) baseSlug = baseSlug.slice(0, 60).replace(/-+$/,'');
    let slug = await ensureUniqueSlug(baseSlug, index);

    // Author info
    const authors = await loadAuthors();
    const pickAuthor = () => {
      if (Array.isArray(authors) && authors.length) {
        const a = authors[Math.floor(Math.random() * authors.length)];
        return { name: a.name || 'HearingAcademy Editorial', title: a.title || 'Audiologist & Hearing Specialist' };
      }
      return { name: 'HearingAcademy Editorial', title: 'Audiologist & Hearing Specialist' };
    };
    const authorInfo = pickAuthor();

    // Image handling
    const storage = String(process.env.IMAGE_STORAGE || 'local').toLowerCase();
    let imageSrc = FALLBACK_IMG;
    let imageAlt = title;
    let imageCredit = '';
    let imageCreditUrl = '';

    if (imageMode === 'upload' && imageUpload instanceof File) {
      const saved = await saveUploadedImage(imageUpload, slug);
      imageSrc = saved.publicPath;
      await registerUsedImage({ provider: 'upload', id: path.basename(saved.filePath), slug, src: imageSrc, credit: '', credit_url: '', original_url: '' });
      if (!imageAlt) imageAlt = suggestAlt({ title, category, tags, filename: saved.filename });
    } else if (imageMode === 'url' && imageUrl) {
      try {
        if (storage === 'local') {
          const dl = await downloadToPublic(imageUrl, slug, 'url', 'remote');
          imageSrc = dl.publicPath;
          if (dl.filePath) await compressImage(dl.filePath);
        } else {
          imageSrc = imageUrl;
        }
        await registerUsedImage({ provider: 'remote', id: imageUrl, slug, src: imageSrc, credit: '', credit_url: '', original_url: imageUrl });
        if (!imageAlt) imageAlt = suggestAlt({ title, category, tags, filename: path.basename(imageUrl) });
      } catch (e: any) {
        console.warn('[upload] image url failed, using fallback:', e?.message || e);
        imageSrc = FALLBACK_IMG;
      }
    } else {
      // auto mode
      try {
        const used = await loadUsedImages();
        const usedUnsplashIds = used.filter((r: any) => String(r.provider).toLowerCase() === 'unsplash').map((r: any) => String(r.id));
        const hero = await findHeroImage({
          query: imageQuery || title,
          category,
          tags,
          keywords: [],
          excludeIds: usedUnsplashIds,
        });
        if (hero) {
          imageSrc = hero.src || FALLBACK_IMG;
          imageAlt = hero.alt || title;
          imageCredit = hero.credit || '';
          imageCreditUrl = hero.credit_url || '';
          if (storage === 'local' && hero.src) {
            try {
              const dl = await downloadToPublic(hero.src, slug, hero.id || 'img', hero.provider || 'unsplash');
              imageSrc = dl.publicPath;
              if (dl.filePath) await compressImage(dl.filePath);
            } catch (e: any) {
              console.warn('[upload] auto image download failed, keeping remote URL:', e?.message || e);
            }
          }
          await registerUsedImage({
            provider: hero.provider || 'unsplash',
            id: hero.id || '',
            slug,
            src: imageSrc,
            credit: imageCredit,
            credit_url: imageCreditUrl,
            original_url: hero.original_url || hero.src || '',
          });
          if (!imageAlt) imageAlt = suggestAlt({ title, category, tags });
        }
      } catch (e: any) {
        console.warn('[upload] auto image failed:', e?.message || e);
      }
    }

    // Reading time
    const reading = readingTime(stripHtml(bodyHtml)).text;

    // Build .astro body
    const nowIso = new Date().toISOString();
    const astro = buildArticleAstro({
      title,
      description,
      publishedTime: nowIso,
      modifiedTime: nowIso,
      author: authorInfo.name,
      authorTitle: authorInfo.title,
      category,
      tags,
      image: imageSrc,
      imageAlt,
      imageCredit,
      imageCreditUrl,
      readingTime: reading,
      body: bodyHtml,
    });

    await ensureDir(ARTICLES_DIR);
    const outPath = path.join(ARTICLES_DIR, `${slug}.astro`);
    await writeFile(outPath, astro);

    // Update index
    const newRec: any = {
      slug,
      title,
      description,
      category,
      tags,
      image: imageSrc,
      publishedTime: nowIso,
      modifiedTime: nowIso,
      readingTime: reading,
    };
    newRec.hash = topicHash({ title: newRec.title, category: newRec.category, tags: newRec.tags, keywords: [] });
    index.unshift(newRec);
    await writeJSON(indexPath, index);

    // Optionally commit to GitHub so production rebuilds
    const toCommit: string[] = [outPath, indexPath];
    // used_images.json may be updated by registerUsedImage()
    const usedImagesPath = path.join(DATA_DIR, 'used_images.json');
    try {
      await fs.access(usedImagesPath);
      toCommit.push(usedImagesPath);
    } catch {}
    // If image stored locally, include it
    if (String(process.env.IMAGE_STORAGE || 'local').toLowerCase() === 'local' && imageSrc && imageSrc.startsWith('/images/')) {
      const absImg = path.join(process.cwd(), 'public', imageSrc.replace(/^\//, ''));
      try {
        await fs.access(absImg);
        toCommit.push(absImg);
      } catch {}
    }

    let pushed = false;
    let pushError: any = null;
    const commitMsg = `content: add ${slug} via upload`;
    const gh = await githubCommitFiles(toCommit, commitMsg);
    pushed = !!gh.ok;
    if (!gh.ok) pushError = gh.details;

    return new Response(
      JSON.stringify({ ok: true, slug, title, pushed, pushError }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (e: any) {
    console.error('[upload] failed:', e?.stack || e?.message || e);
    return new Response(JSON.stringify({ error: e?.message || 'Upload failed' }), { status: 500 });
  }
};
