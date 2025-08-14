import path from 'node:path';
import fs from 'node:fs/promises';
import matter from 'gray-matter';
import { marked } from 'marked';
import readingTime from 'reading-time';
import sharp from 'sharp';
import { Busboy } from '@fastify/busboy';

// Project utilities
import { ARTICLES_DIR, DATA_DIR, ensureDir, readJSON, writeJSON, writeFile } from '../../scripts/utils/fs.js';
import { buildArticleAstro, makeSlug, makeCompactSlug } from '../../scripts/utils/astroArticle.js';
import { loadCategories, loadAuthors } from '../../scripts/utils/config.js';
import { loadUsedImages, registerUsedImage, downloadToPublic } from '../../scripts/utils/images.js';
import { findHeroImage } from '../../scripts/utils/unsplash.js';
import { topicHash } from '../../scripts/utils/dedupe.js';

const FALLBACK_IMG = '/images/articles/2025-08/ai-hearing-aids-noise-pexels-14682242.jpg';

async function githubCommitFiles(filePaths: string[], message: string): Promise<{ ok: boolean; details?: any }> {
  try {
    const token = String(process.env.GITHUB_TOKEN || '').trim();
    const repo = String(process.env.GITHUB_REPO || '').trim(); // owner/name
    const branch = String(process.env.GITHUB_BRANCH || 'main').trim();
    if (!token || !repo) return { ok: false, details: 'Missing GITHUB_TOKEN or GITHUB_REPO' };
    const [owner, name] = repo.split('/');
    if (!owner || !name) return { ok: false, details: 'GITHUB_REPO must be owner/name' };

    const root = process.cwd();

    const putFile = async (absPath: string) => {
      let rel = absPath.startsWith(root) ? absPath.slice(root.length) : absPath;
      if (rel.startsWith(path.sep)) rel = rel.slice(1);
      const buf = await fs.readFile(absPath);
      const contentB64 = buf.toString('base64');

      // Get existing SHA
      const getUrl = `https://api.github.com/repos/${owner}/${name}/contents/${encodeURIComponent(rel)}?ref=${encodeURIComponent(branch)}`;
      let sha: string | undefined;
      try {
        const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'HearingAcademy-Uploader' } });
        if (getRes.ok) {
          const j: any = await getRes.json();
          if (j && j.sha) sha = j.sha;
        }

// Optional: compress an image buffer and return a new buffer (keeps same format where possible)
async function compressImageBuffer(input: Buffer, extHint: string): Promise<Buffer> {
  try {
    const ext = (extHint || '').toLowerCase();
    const img = sharp(input, { failOn: 'none' });
    if (ext === 'jpg' || ext === 'jpeg' || !['png','webp','avif'].includes(ext)) {
      return await img.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    } else if (ext === 'png') {
      return await img.png({ compressionLevel: 9, adaptiveFiltering: true, palette: true }).toBuffer();
    } else if (ext === 'webp') {
      return await img.webp({ quality: 82, effort: 4 }).toBuffer();
    } else if (ext === 'avif') {
      return await img.avif({ quality: 50, effort: 4 }).toBuffer();
    }
    return await img.jpeg({ quality: 82, mozjpeg: true }).toBuffer();
  } catch {
    return input; // fallback to original buffer on error
  }
}
      } catch {}

      const putUrl = `https://api.github.com/repos/${owner}/${name}/contents/${encodeURIComponent(rel)}`;
      const body: any = { message, content: contentB64, branch, sha };
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

    for (const fp of filePaths) await putFile(fp);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, details: e?.message || String(e) };
  }
}

// Put a file to GitHub using in-memory content (Buffer or string), avoiding local FS
async function githubPutFileFromContent(relPath: string, content: Buffer | string, message: string): Promise<{ ok: boolean; details?: any }> {
  try {
    const token = String(process.env.GITHUB_TOKEN || '').trim();
    const repo = String(process.env.GITHUB_REPO || '').trim(); // owner/name
    const branch = String(process.env.GITHUB_BRANCH || 'main').trim();
    if (!token || !repo) return { ok: false, details: 'Missing GITHUB_TOKEN or GITHUB_REPO' };
    const [owner, name] = repo.split('/');
    if (!owner || !name) return { ok: false, details: 'GITHUB_REPO must be owner/name' };

    const getUrl = `https://api.github.com/repos/${owner}/${name}/contents/${encodeURIComponent(relPath)}?ref=${encodeURIComponent(branch)}`;
    let sha: string | undefined;
    try {
      const getRes = await fetch(getUrl, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'HearingAcademy-Uploader' } });
      if (getRes.ok) {
        const j: any = await getRes.json();
        if (j && j.sha) sha = j.sha;
      }
    } catch {}

    const putUrl = `https://api.github.com/repos/${owner}/${name}/contents/${encodeURIComponent(relPath)}`;
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const body: any = { message, content: buf.toString('base64'), branch, sha };
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
      return { ok: false, details: `GitHub PUT failed for ${relPath}: ${res.status} ${txt}` };
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
    if (ext === 'jpg' || ext === 'jpeg') {
      await img.jpeg({ quality: 82, mozjpeg: true }).toFile(filePath + '.tmp');
    } else if (ext === 'png') {
      await img.png({ compressionLevel: 9, adaptiveFiltering: true, palette: true }).toFile(filePath + '.tmp');
    } else if (ext === 'webp') {
      await img.webp({ quality: 82, effort: 4 }).toFile(filePath + '.tmp');
    } else if (ext === 'avif') {
      await img.avif({ quality: 50, effort: 4 }).toFile(filePath + '.tmp');
    } else {
      await img.jpeg({ quality: 82, mozjpeg: true }).toFile(filePath + '.tmp');
    }
    await fs.rename(filePath + '.tmp', filePath);
  } catch (e) {
    console.warn('[upload-fn] image compression skipped:', (e as any)?.message || e);
  }
}

function suggestAlt({ title, category, tags, filename }: { title: string; category: string; tags: string[]; filename?: string }): string {
  const base = title?.trim();
  if (base) return base;
  const name = (filename || '').replace(/[-_]/g, ' ').replace(/\.[a-z0-9]{2,4}$/i, '');
  const parts = [name, category, (tags && tags[0]) || ''].map((s) => String(s || '').trim()).filter(Boolean);
  return parts[0] || 'Article hero image';
}

function stripLeadingH1(html: string): string {
  const s = String(html || '');
  return s.replace(/^[\s\S]*?<h1[^>]*>[\s\S]*?<\/h1>\s*/i, () => '');
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

async function saveUploadedBuffer(file: { data: Buffer; filename?: string; mimeType?: string }, slug: string): Promise<{ publicPath: string; filePath: string; filename: string }> {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dir = path.join(process.cwd(), 'public', 'images', 'articles', ym);
  await fs.mkdir(dir, { recursive: true });
  const name = file.filename || 'upload';
  const extMatch = name.match(/\.([a-zA-Z0-9]{3,4})$/);
  const extFromType = (file.mimeType || '').split('/').pop() || '';
  const ext = (extMatch ? extMatch[1].toLowerCase() : (extFromType || 'jpg'));
  const safeExt = ['jpg','jpeg','png','webp','avif'].includes(ext) ? ext : 'jpg';
  const filename = `${slug}-upload-${Date.now()}.${safeExt}`;
  const target = path.join(dir, filename);
  await fs.writeFile(target, file.data);
  await compressImage(target);
  const publicPath = `/images/articles/${ym}/${filename}`;
  return { publicPath, filePath: target, filename };
}

async function parseMultipart(body: Buffer, contentType: string): Promise<{ fields: Record<string, string>, files: Record<string, { data: Buffer, filename?: string, mimeType?: string }> }> {
  return new Promise((resolve, reject) => {
    const fields: Record<string, string> = {};
    const files: Record<string, { data: Buffer, filename?: string, mimeType?: string }> = {};
    const bb = Busboy({ headers: { 'content-type': contentType } as any });

    bb.on('field', (name: string, val: string) => { fields[name] = val; });
    bb.on('file', (_name: string, stream: any, info: any) => {
      const chunks: Buffer[] = [];
      stream.on('data', (d: Buffer) => chunks.push(d));
      stream.on('limit', () => console.warn('[upload-fn] file size limit reached'));
      stream.on('end', () => {
        files[_name] = { data: Buffer.concat(chunks), filename: info?.filename, mimeType: info?.mimeType };
      });
    });
    bb.on('error', reject);
    bb.on('finish', () => resolve({ fields, files }));

    bb.end(body);
  });
}

export const handler = async (event: any) => {
  try {
    const READ_ONLY = (process.env.NETLIFY === 'true') || !!process.env.AWS_REGION || !!process.env.AWS_EXECUTION_ENV || !!process.env.LAMBDA_TASK_ROOT;
    // console.log('[upload-fn] runtime:', READ_ONLY ? 'read-only (lambda)' : 'writable (local)');
    const ct = String(event.headers?.['content-type'] || event.headers?.['Content-Type'] || '');
    const isMultipart = ct.includes('multipart/form-data');

    let mdText = '';
    let providedTitle = '';
    let providedDesc = '';
    let providedCategory = '';
    let tagsStr = '';
    let imageMode = 'auto';
    let imageQuery = '';
    let imageUrl = '';
    let providedSlugRaw = '';
    let imageUpload: { data: Buffer; filename?: string; mimeType?: string } | null = null;

    if (isMultipart) {
      const bodyBuf = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8');
      const { fields, files } = await parseMultipart(bodyBuf, ct);
      providedTitle = String(fields['title'] || '');
      providedDesc = String(fields['description'] || '');
      providedCategory = String(fields['category'] || '');
      tagsStr = String(fields['tags'] || '');
      imageMode = String(fields['imageMode'] || 'auto');
      imageQuery = String(fields['imageQuery'] || '');
      imageUrl = String(fields['imageUrl'] || '');
      providedSlugRaw = String(fields['slug'] || '');

      const md = files['mdfile'];
      if (!md || !md.data?.length) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing Markdown file (mdfile).' }) };
      }
      mdText = md.data.toString('utf8');
      if (files['imageUpload']) imageUpload = files['imageUpload'];
    } else {
      const json = (() => { try { return JSON.parse(event.body || '{}'); } catch { return {}; } })();
      mdText = String(json.md || json.markdown || '');
      if (!mdText) return { statusCode: 400, body: JSON.stringify({ error: 'Missing markdown in body (md/markdown).' }) };
      providedTitle = String(json.title || '');
      providedDesc = String(json.description || '');
      providedCategory = String(json.category || '');
      tagsStr = String(json.tags || '');
      imageMode = String(json.imageMode || 'auto');
      imageQuery = String(json.imageQuery || '');
      imageUrl = String(json.imageUrl || '');
      providedSlugRaw = String(json.slug || '');
      // imageUpload not supported in JSON mode
    }

    const fm = matter(mdText);
    const title = (providedTitle || String(fm.data.title || '').trim() || (fm.content.match(/^#\s+(.+?)\s*$/m)?.[1] || 'Untitled')).trim();
    const rawHtml = marked.parse(fm.content);
    const bodyHtml = stripLeadingH1(String(rawHtml));
    const description = providedDesc || String(fm.data.description || summarizeDescriptionFromHtml(bodyHtml));

    const categories = await loadCategories();
    const category = providedCategory || String(fm.data.category || categories[0] || 'Hearing Health');

    const tags = (() => {
      const fromForm = tagsStr ? String(tagsStr).split(',').map((s) => s.trim()).filter(Boolean) : [];
      const fromFm = Array.isArray(fm.data.tags) ? (fm.data.tags as any[]).map((s) => String(s)) : [];
      const merged = [...fromForm, ...fromFm];
      const uniq: string[] = [];
      for (const t of merged) { const tt = t.trim(); if (tt && !uniq.includes(tt)) uniq.push(tt); }
      return uniq.slice(0, 10);
    })();

    const indexPath = path.join(DATA_DIR, 'topics_index.json');
    const index = (await readJSON(indexPath, null)) || [];

    let baseSlug: string;
    if (providedSlugRaw) baseSlug = makeSlug(providedSlugRaw);
    else {
      const kw: string[] = Array.isArray(tags) ? tags.map((t: any) => String(t)) : [];
      const compact = (makeCompactSlug as any)({ title, keywords: kw, maxLen: 60, maxWords: 6 });
      const fallback = makeSlug(title);
      baseSlug = compact || fallback;
    }
    if (baseSlug.length > 60) baseSlug = baseSlug.slice(0, 60).replace(/-+$/, '');
    const slug = await ensureUniqueSlug(baseSlug, index);

    const authors = await loadAuthors();
    const authorInfo = (() => {
      if (Array.isArray(authors) && authors.length) {
        const a = authors[Math.floor(Math.random() * authors.length)];
        return { name: a.name || 'HearingAcademy Editorial', title: a.title || 'Audiologist & Hearing Specialist' };
      }
      return { name: 'HearingAcademy Editorial', title: 'Audiologist & Hearing Specialist' };
    })();

    let storage = String(process.env.IMAGE_STORAGE || 'local').toLowerCase();
    if (READ_ONLY && storage === 'local') storage = 'remote';
    let imageSrc = FALLBACK_IMG;
    let imageAlt = title;
    let imageCredit = '';
    let imageCreditUrl = '';

    if (imageMode === 'upload' && imageUpload) {
      if (READ_ONLY) {
        // In Netlify runtime, skip local writes; fallback to default image
        console.warn('[upload-fn] upload image disabled on read-only FS, using fallback image');
        imageSrc = FALLBACK_IMG;
      } else {
        const saved = await saveUploadedBuffer(imageUpload, slug);
        imageSrc = saved.publicPath;
        await registerUsedImage({ provider: 'upload', id: path.basename(saved.filePath), slug, src: imageSrc, credit: '', credit_url: '', original_url: '' });
        if (!imageAlt) imageAlt = suggestAlt({ title, category, tags, filename: saved.filename });
      }
    } else if (imageMode === 'url' && imageUrl) {
      try {
        if (storage === 'local') {
          // In READ_ONLY we forced storage to 'remote', so this branch only executes locally
          const dl = await downloadToPublic(imageUrl, slug, 'url', 'remote');
          imageSrc = dl.publicPath;
          if (dl.filePath) await compressImage(dl.filePath);
          await registerUsedImage({ provider: 'remote', id: imageUrl, slug, src: imageSrc, credit: '', credit_url: '', original_url: imageUrl });
        } else {
          imageSrc = imageUrl;
        }
        if (!imageAlt) imageAlt = suggestAlt({ title, category, tags, filename: path.basename(imageUrl) });
      } catch (e: any) {
        console.warn('[upload-fn] image url failed, using fallback:', e?.message || e);
        imageSrc = FALLBACK_IMG;
      }
    } else {
      try {
        const used = READ_ONLY ? [] : await loadUsedImages();
        const usedUnsplashIds = Array.isArray(used) ? used.filter((r: any) => String(r.provider).toLowerCase() === 'unsplash').map((r: any) => String(r.id)) : [];
        const hero = await findHeroImage({ query: imageQuery || title, category, tags, keywords: [], excludeIds: usedUnsplashIds });
        if (hero) {
          imageSrc = hero.src || FALLBACK_IMG;
          imageAlt = hero.alt || title;
          imageCredit = hero.credit || '';
          imageCreditUrl = hero.credit_url || '';
          if (!READ_ONLY && storage === 'local' && hero.src) {
            try {
              const dl = await downloadToPublic(hero.src, slug, hero.id || 'img', hero.provider || 'unsplash');
              imageSrc = dl.publicPath;
              if (dl.filePath) await compressImage(dl.filePath);
            } catch (e: any) {
              console.warn('[upload-fn] auto image download failed, keeping remote URL:', e?.message || e);
            }
          }
          if (!READ_ONLY) {
            await registerUsedImage({ provider: hero.provider || 'unsplash', id: hero.id || '', slug, src: imageSrc, credit: imageCredit, credit_url: imageCreditUrl, original_url: hero.original_url || hero.src || '' });
          }
          if (!imageAlt) imageAlt = suggestAlt({ title, category, tags });
        }
      } catch (e: any) {
        console.warn('[upload-fn] auto image failed:', e?.message || e);
      }
    }

    const reading = readingTime(stripHtml(bodyHtml)).text;
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

    const newRec: any = { slug, title, description, category, tags, image: imageSrc, publishedTime: nowIso, modifiedTime: nowIso, readingTime: reading };
    newRec.hash = topicHash({ title: newRec.title, category: newRec.category, tags: newRec.tags, keywords: [] });
    index.unshift(newRec);

    let gh: { ok: boolean; details?: any } = { ok: true };
    const commitMsg = `content: add ${slug} via upload`;
    if (READ_ONLY) {
      // Commit directly to GitHub (no local FS writes)
      const relArticle = `src/pages/articles/${slug}.astro`;
      const relIndex = 'src/data/topics_index.json';
      const p1 = await githubPutFileFromContent(relArticle, astro, commitMsg);
      const p2 = await githubPutFileFromContent(relIndex, Buffer.from(JSON.stringify(index, null, 2) + '\n', 'utf8'), commitMsg);
      // Note: images are kept remote in READ_ONLY mode per storage override
      gh = (p1.ok && p2.ok) ? { ok: true } : { ok: false, details: [p1.details, p2.details].filter(Boolean).join(' | ') };
    } else {
      // Local write + commit paths for non-Netlify environments
      await ensureDir(ARTICLES_DIR);
      const outPath = path.join(ARTICLES_DIR, `${slug}.astro`);
      await writeFile(outPath, astro);
      await writeJSON(indexPath, index);

      const toCommit: string[] = [outPath, indexPath];
      const usedImagesPath = path.join(DATA_DIR, 'used_images.json');
      try { await fs.access(usedImagesPath); toCommit.push(usedImagesPath); } catch {}
      if (String(process.env.IMAGE_STORAGE || 'local').toLowerCase() === 'local' && imageSrc && imageSrc.startsWith('/images/')) {
        const absImg = path.join(process.cwd(), 'public', imageSrc.replace(/^\//, ''));
        try { await fs.access(absImg); toCommit.push(absImg); } catch {}
      }
      gh = await githubCommitFiles(toCommit, commitMsg);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, slug, title, pushed: !!gh.ok, pushError: gh.ok ? null : gh.details }),
    };
  } catch (e: any) {
    console.error('[upload-fn] failed:', e?.stack || e?.message || e);
    return { statusCode: 500, body: JSON.stringify({ error: e?.message || 'Upload failed' }) };
  }
};
