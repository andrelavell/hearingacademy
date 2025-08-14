import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, readJSON, writeJSON } from './fs.js';

// Persisted registry of used images to avoid duplicates across articles
const USED_IMAGES_PATH = path.join(DATA_DIR, 'used_images.json');

export async function loadUsedImages() {
  const arr = (await readJSON(USED_IMAGES_PATH, [])) || [];
  return Array.isArray(arr) ? arr : [];
}

export async function saveUsedImages(list) {
  await writeJSON(USED_IMAGES_PATH, Array.isArray(list) ? list : []);
}

export function isImageUsed(usedList, provider, id) {
  const pid = String(id);
  const prov = String(provider || '').toLowerCase();
  return Array.isArray(usedList) && usedList.some((r) => String(r.provider).toLowerCase() === prov && String(r.id) === pid);
}

export async function registerUsedImage({ provider, id, slug, src, credit, credit_url, original_url }) {
  const list = await loadUsedImages();
  list.unshift({
    provider: String(provider || ''),
    id: String(id || ''),
    slug: String(slug || ''),
    src: String(src || ''),
    credit: String(credit || ''),
    credit_url: String(credit_url || ''),
    original_url: String(original_url || ''),
    date: new Date().toISOString(),
  });
  // Keep last 1000 to cap file size
  const capped = list.slice(0, 1000);
  await saveUsedImages(capped);
}

export async function downloadToPublic(url, slug, id, provider = 'unsplash') {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dir = path.join(process.cwd(), 'public', 'images', 'articles', ym);
  await fs.mkdir(dir, { recursive: true });

  // Try to preserve extension from URL when possible
  const u = String(url || '');
  const m = u.match(/\.([a-zA-Z0-9]{3,4})(?:\?|#|$)/);
  const ext = (m ? m[1].toLowerCase() : 'jpg');
  const safeExt = ['jpg','jpeg','png','webp','avif'].includes(ext) ? ext : 'jpg';

  const filename = `${slug}-${String(provider).toLowerCase()}-${id}.${safeExt}`;
  const filePath = path.join(dir, filename);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(filePath, buf);

  const publicPath = `/images/articles/${ym}/${filename}`;
  return { filePath, publicPath };
}
