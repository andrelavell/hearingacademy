import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';

export const ROOT = path.resolve(process.cwd());
export const ARTICLES_DIR = path.join(ROOT, 'src', 'pages', 'articles');
export const DATA_DIR = path.join(ROOT, 'src', 'data');

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readJSON(filePath, defaultValue = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return defaultValue;
    throw e;
  }
}

export async function writeJSON(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export async function listArticleFiles() {
  const pattern = path.posix.join('src', 'pages', 'articles', '**', '*.astro');
  const entries = await fg(pattern, { cwd: ROOT, dot: false });
  return entries.map((rel) => path.join(ROOT, rel));
}

export async function readFile(filePath) {
  return fs.readFile(filePath, 'utf8');
}

export async function writeFile(filePath, content) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf8');
}

export function slugFromFilename(filePath) {
  return path.basename(filePath, '.astro');
}
